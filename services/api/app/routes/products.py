from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..auth import Tenant
from ..config import Settings, get_settings
from ..database import get_db
from ..models import AuditLog, Product, ProductAnchor, ProductAsset
from ..schemas import AnchorCreate, ProductCreate, ProductResponse, ProductUpdate
from ..security import read_validated_image
from ..storage import create_simple_cutout, process_image, public_storage_url

router = APIRouter(prefix="/products", tags=["products"])
Db = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.post("", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
def create_product(
    payload: ProductCreate,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> ProductResponse:
    product = Product(
        organization_id=tenant.organization_id,
        name=payload.name,
        description=payload.description,
        sku=payload.sku,
        width_cm=payload.width_cm,
        height_cm=payload.height_cm,
        depth_cm=payload.depth_cm,
        material=payload.material,
        placement_type=payload.placement_type,
        lighting_profile=payload.lighting_profile,
        buy_url=str(payload.buy_url) if payload.buy_url else None,
    )
    db.add(product)
    db.flush()
    db.add(
        ProductAnchor(
            organization_id=tenant.organization_id,
            product_id=product.id,
            anchor_type="bottom_center",
            x_normalized=0.5,
            y_normalized=1,
        )
    )
    _audit(db, tenant.organization_id, tenant.user_id, "product.created", product.id)
    db.commit()
    db.refresh(product)
    return _product_response(product, settings)


@router.get("", response_model=list[ProductResponse])
def list_products(db: Db, tenant: Tenant, settings: AppSettings) -> list[ProductResponse]:
    products = db.scalars(
        select(Product)
        .options(selectinload(Product.assets))
        .where(
            Product.organization_id == tenant.organization_id,
            Product.deleted_at.is_(None),
        )
        .order_by(Product.created_at.desc())
    ).all()
    return [_product_response(product, settings) for product in products]


@router.get("/{product_id}", response_model=ProductResponse)
def get_product(product_id: str, db: Db, tenant: Tenant, settings: AppSettings) -> ProductResponse:
    return _product_response(_get_product(db, tenant.organization_id, product_id), settings)


@router.patch("/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: str,
    payload: ProductUpdate,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> ProductResponse:
    product = _get_product(db, tenant.organization_id, product_id)
    values = payload.model_dump(exclude_unset=True)
    if "buy_url" in values:
        values["buy_url"] = str(values["buy_url"]) if values["buy_url"] else None
    for key, value in values.items():
        setattr(product, key, value)
    _audit(db, tenant.organization_id, tenant.user_id, "product.updated", product.id)
    db.commit()
    db.refresh(product)
    return _product_response(product, settings)


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: str, db: Db, tenant: Tenant) -> None:
    product = _get_product(db, tenant.organization_id, product_id)
    product.deleted_at = datetime.now(UTC)
    product.status = "archived"
    _audit(db, tenant.organization_id, tenant.user_id, "product.deleted", product.id)
    db.commit()


@router.post("/{product_id}/assets", response_model=ProductResponse)
async def upload_product_asset(
    product_id: str,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
    file: Annotated[UploadFile, File()],
) -> ProductResponse:
    product = _get_product(db, tenant.organization_id, product_id)
    content, mime, width, height = await read_validated_image(file, settings)
    processed = process_image(content, namespace=f"products/{product.id}", settings=settings)
    asset = ProductAsset(
        organization_id=tenant.organization_id,
        product_id=product.id,
        kind="primary",
        original_path=str(processed.original_path),
        sanitized_path=str(processed.sanitized_path),
        thumbnail_path=str(processed.thumbnail_path),
        mime_type=mime,
        width_px=width,
        height_px=height,
        size_bytes=processed.size_bytes,
    )
    db.add(asset)
    product.visual_fingerprint = processed.fingerprint
    product.status = "draft"
    _audit(db, tenant.organization_id, tenant.user_id, "product.asset_uploaded", product.id)
    db.commit()
    db.refresh(product)
    return _product_response(product, settings)


@router.post("/{product_id}/prepare", response_model=ProductResponse)
def prepare_product(
    product_id: str,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> ProductResponse:
    product = _get_product(db, tenant.organization_id, product_id)
    asset = db.scalar(
        select(ProductAsset)
        .where(
            ProductAsset.product_id == product.id,
            ProductAsset.organization_id == tenant.organization_id,
            ProductAsset.deleted_at.is_(None),
        )
        .order_by(ProductAsset.created_at.desc())
    )
    if asset is None:
        raise HTTPException(status_code=409, detail="Upload a product image before preparation")
    product.status = "processing"
    db.flush()
    cutout, mask = create_simple_cutout(Path(asset.sanitized_path))
    asset.cutout_path = str(cutout)
    asset.mask_path = str(mask)
    product.status = "ready"
    _audit(db, tenant.organization_id, tenant.user_id, "product.prepared", product.id)
    db.commit()
    db.refresh(product)
    return _product_response(product, settings)


@router.post("/{product_id}/anchor")
def set_anchor(product_id: str, payload: AnchorCreate, db: Db, tenant: Tenant) -> dict[str, object]:
    product = _get_product(db, tenant.organization_id, product_id)
    existing = db.scalar(
        select(ProductAnchor).where(
            ProductAnchor.product_id == product.id,
            ProductAnchor.organization_id == tenant.organization_id,
        )
    )
    anchor = existing or ProductAnchor(
        organization_id=tenant.organization_id,
        product_id=product.id,
    )
    anchor.anchor_type = payload.anchor_type
    anchor.x_normalized = payload.x_normalized
    anchor.y_normalized = payload.y_normalized
    db.add(anchor)
    db.commit()
    return {
        "id": anchor.id,
        "anchorType": anchor.anchor_type,
        "xNormalized": anchor.x_normalized,
        "yNormalized": anchor.y_normalized,
    }


def _get_product(db: Session, organization_id: str, product_id: str) -> Product:
    product = db.scalar(
        select(Product)
        .options(selectinload(Product.assets))
        .where(
            Product.id == product_id,
            Product.organization_id == organization_id,
            Product.deleted_at.is_(None),
        )
    )
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


def _product_response(product: Product, settings: Settings) -> ProductResponse:
    assets = [asset for asset in product.assets if asset.deleted_at is None]
    asset = max(assets, key=lambda item: item.created_at) if assets else None
    return ProductResponse(
        id=product.id,
        name=product.name,
        description=product.description,
        sku=product.sku,
        width_cm=product.width_cm,
        height_cm=product.height_cm,
        depth_cm=product.depth_cm,
        material=product.material,
        placement_type=product.placement_type,
        status=product.status,
        buy_url=product.buy_url,
        asset_url=public_storage_url(asset.sanitized_path, settings) if asset else None,
        cutout_url=public_storage_url(asset.cutout_path, settings) if asset else None,
        created_at=product.created_at,
    )


def _audit(db: Session, organization_id: str, user_id: str, action: str, entity_id: str) -> None:
    db.add(
        AuditLog(
            organization_id=organization_id,
            actor_user_id=user_id,
            action=action,
            entity_type="product",
            entity_id=entity_id,
        )
    )
