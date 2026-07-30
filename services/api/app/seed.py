from pathlib import Path

from PIL import Image, ImageDraw
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .credits import get_or_create_wallet
from .models import (
    Membership,
    Organization,
    Product,
    ProductAnchor,
    ProductAsset,
    User,
    Widget,
)


def seed_demo(db: Session, settings: Settings) -> None:
    _create_demo_room(settings.storage_path)
    organization = db.get(Organization, settings.demo_organization_id)
    if organization is None:
        organization = Organization(
            id=settings.demo_organization_id,
            name="Atelier Lili",
            slug="atelier-lili",
        )
        db.add(organization)
    user = db.get(User, settings.demo_user_id)
    if user is None:
        user = User(
            id=settings.demo_user_id,
            email="demo@project-visualizer.local",
            display_name="Lili Demo",
        )
        db.add(user)
    db.flush()

    membership = db.scalar(
        select(Membership).where(
            Membership.organization_id == organization.id,
            Membership.user_id == user.id,
        )
    )
    if membership is None:
        db.add(Membership(organization_id=organization.id, user_id=user.id, role="owner"))

    get_or_create_wallet(db, organization.id, settings.initial_demo_credits)
    product = db.scalar(
        select(Product).where(
            Product.organization_id == organization.id,
            Product.sku == "DEMO-VASE-01",
        )
    )
    if product is None:
        product = Product(
            organization_id=organization.id,
            name="Vase Sable",
            description="Céramique artisanale aux lignes organiques.",
            sku="DEMO-VASE-01",
            width_cm=24,
            height_cm=42,
            depth_cm=24,
            material="céramique mate",
            placement_type="table",
            lighting_profile={"reflectance": "matte", "temperature": "warm"},
            status="ready",
            buy_url="https://example.com/products/vase-sable",
            visual_fingerprint="demo-vase-sable-v1",
        )
        db.add(product)
        db.flush()
        paths = _create_demo_product(settings.storage_path)
        asset = ProductAsset(
            organization_id=organization.id,
            product_id=product.id,
            kind="primary",
            original_path=str(paths["original"]),
            sanitized_path=str(paths["sanitized"]),
            thumbnail_path=str(paths["thumbnail"]),
            cutout_path=str(paths["cutout"]),
            mask_path=str(paths["mask"]),
            mime_type="image/png",
            width_px=800,
            height_px=1_000,
            size_bytes=paths["original"].stat().st_size,
        )
        db.add(asset)
        db.add(
            ProductAnchor(
                organization_id=organization.id,
                product_id=product.id,
                anchor_type="bottom_center",
                x_normalized=0.5,
                y_normalized=1,
            )
        )

    widget = db.scalar(
        select(Widget).where(
            Widget.organization_id == organization.id,
            Widget.merchant_slug == organization.slug,
        )
    )
    if widget is None:
        db.add(
            Widget(
                organization_id=organization.id,
                name="Visualizer principal",
                merchant_slug=organization.slug,
                allowed_origins=["http://localhost:3000"],
                configuration={
                    "buttonLabel": "Voir chez moi",
                    "accentColor": "#6f7753",
                    "buyLabel": "Acheter cet objet",
                },
            )
        )
    db.commit()


def _create_demo_product(storage_root: Path) -> dict[str, Path]:
    directory = storage_root / "demo"
    directory.mkdir(parents=True, exist_ok=True)
    original = directory / "vase-sable.png"
    sanitized = directory / "vase-sable.webp"
    thumbnail = directory / "vase-sable.thumb.webp"
    cutout = directory / "vase-sable.cutout.png"
    mask = directory / "vase-sable.mask.png"
    if not cutout.exists():
        canvas = Image.new("RGBA", (800, 1_000), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        draw.ellipse((255, 90, 545, 230), fill=(204, 174, 132, 255))
        draw.rounded_rectangle((210, 170, 590, 855), radius=170, fill=(196, 158, 112, 255))
        draw.ellipse((260, 775, 540, 900), fill=(178, 139, 98, 255))
        draw.ellipse((315, 108, 485, 172), fill=(84, 63, 46, 255))
        for offset in range(0, 260, 28):
            draw.arc(
                (235 + offset // 8, 245 + offset, 565 - offset // 8, 650 + offset),
                185,
                350,
                fill=(222, 192, 150, 160),
                width=5,
            )
        canvas.save(original, "PNG", optimize=True)
        canvas.save(cutout, "PNG", optimize=True)
        canvas.getchannel("A").save(mask, "PNG", optimize=True)
        canvas.convert("RGB").save(sanitized, "WEBP", quality=94)
        thumb = canvas.copy()
        thumb.thumbnail((400, 400))
        thumb.save(thumbnail, "WEBP", quality=88)
    return {
        "original": original,
        "sanitized": sanitized,
        "thumbnail": thumbnail,
        "cutout": cutout,
        "mask": mask,
    }


def _create_demo_room(storage_root: Path) -> Path:
    directory = storage_root / "demo"
    directory.mkdir(parents=True, exist_ok=True)
    room_path = directory / "demo-room.png"
    if room_path.exists():
        return room_path
    room = Image.new("RGB", (1_200, 800), (220, 211, 196))
    draw = ImageDraw.Draw(room)
    draw.rectangle((0, 565, 1_200, 800), fill=(151, 120, 91))
    draw.rectangle((92, 80, 475, 420), fill=(239, 232, 218), outline=(246, 241, 232), width=18)
    draw.rectangle((115, 103, 452, 397), fill=(177, 190, 165))
    draw.ellipse((570, 570, 1_090, 770), fill=(187, 166, 135))
    draw.rounded_rectangle((520, 475, 1_060, 585), radius=18, fill=(101, 75, 56))
    draw.rectangle((560, 580, 595, 760), fill=(73, 54, 42))
    draw.rectangle((985, 580, 1_020, 760), fill=(73, 54, 42))
    draw.ellipse((910, 170, 1_070, 500), fill=(94, 118, 75))
    draw.ellipse((860, 240, 1_020, 535), fill=(113, 139, 90))
    draw.rectangle((945, 450, 970, 600), fill=(78, 65, 43))
    room.save(room_path, "PNG", optimize=True)
    return room_path
