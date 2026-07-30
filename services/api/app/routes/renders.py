from datetime import UTC, datetime
from typing import Annotated, TypeVar, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..auth import Tenant
from ..config import Settings, get_settings
from ..credits import InsufficientCreditsError, reserve_credit
from ..database import get_db
from ..models import Calibration, Placement, Product, Render, Scene, SceneSurface
from ..rendering.pipeline import execute_render, select_size
from ..schemas import RenderAttemptResponse, RenderCreate, RenderResponse
from ..storage import public_storage_url

router = APIRouter(prefix="/renders", tags=["renders"])
Db = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.get("", response_model=list[RenderResponse])
def list_renders(
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> list[RenderResponse]:
    values = db.scalars(
        select(Render)
        .options(selectinload(Render.attempts))
        .where(
            Render.organization_id == tenant.organization_id,
            Render.deleted_at.is_(None),
        )
        .order_by(Render.created_at.desc())
        .limit(100)
    ).all()
    return [_render_response(value, settings) for value in values]


@router.post("", response_model=RenderResponse, status_code=status.HTTP_201_CREATED)
def create_render(
    payload: RenderCreate,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> RenderResponse:
    existing = db.scalar(
        select(Render)
        .options(selectinload(Render.attempts))
        .where(
            Render.organization_id == tenant.organization_id,
            Render.idempotency_key == payload.idempotency_key,
        )
    )
    if existing:
        return _render_response(existing, settings)

    scene = _tenant_entity(db, Scene, payload.placement.scene_id, tenant.organization_id)
    _tenant_entity(db, Product, payload.placement.product_id, tenant.organization_id)
    if payload.placement.surface_id:
        _tenant_entity(
            db, SceneSurface, payload.placement.surface_id, tenant.organization_id
        )
    if payload.placement.calibration_id:
        _tenant_entity(
            db, Calibration, payload.placement.calibration_id, tenant.organization_id
        )

    placement = Placement(
        organization_id=tenant.organization_id,
        scene_id=payload.placement.scene_id,
        product_id=payload.placement.product_id,
        surface_id=payload.placement.surface_id,
        calibration_id=payload.placement.calibration_id,
        mode=payload.placement.mode,
        x_normalized=payload.placement.x_normalized,
        y_normalized=payload.placement.y_normalized,
        scale=payload.placement.scale,
        rotation_degrees=payload.placement.rotation_degrees,
        lighting=payload.placement.lighting,
    )
    db.add(placement)
    db.flush()
    render = Render(
        organization_id=tenant.organization_id,
        placement_id=placement.id,
        idempotency_key=payload.idempotency_key,
        status="queued",
        quality=payload.quality,
        requested_size=select_size(scene.width_px, scene.height_px),
        fidelity_mode=payload.fidelity_mode,
    )
    db.add(render)
    db.flush()
    try:
        reserve_credit(db, tenant.organization_id, render.id)
    except InsufficientCreditsError as exc:
        db.rollback()
        raise HTTPException(status_code=402, detail=str(exc)) from exc
    db.commit()
    db.refresh(render)

    render = execute_render(db, render, settings)
    db.refresh(render, attribute_names=["attempts"])
    return _render_response(render, settings)


@router.get("/{render_id}", response_model=RenderResponse)
def get_render(
    render_id: str,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> RenderResponse:
    render = _get_render(db, tenant.organization_id, render_id)
    return _render_response(render, settings)


@router.post("/{render_id}/retry", response_model=RenderResponse, status_code=201)
def retry_render(
    render_id: str,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> RenderResponse:
    original = _get_render(db, tenant.organization_id, render_id)
    if original.status != "failed":
        raise HTTPException(status_code=409, detail="Only failed renders can be retried")
    retry = Render(
        organization_id=tenant.organization_id,
        placement_id=original.placement_id,
        idempotency_key=f"{original.idempotency_key}:retry:{uuid4().hex[:12]}",
        status="queued",
        quality=original.quality,
        requested_size=original.requested_size,
        fidelity_mode=original.fidelity_mode,
    )
    db.add(retry)
    db.flush()
    try:
        reserve_credit(db, tenant.organization_id, retry.id)
    except InsufficientCreditsError as exc:
        db.rollback()
        raise HTTPException(status_code=402, detail=str(exc)) from exc
    db.commit()
    db.refresh(retry)
    retry = execute_render(db, retry, settings)
    db.refresh(retry, attribute_names=["attempts"])
    return _render_response(retry, settings)


@router.delete("/{render_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_render(render_id: str, db: Db, tenant: Tenant) -> None:
    render = _get_render(db, tenant.organization_id, render_id)
    render.deleted_at = datetime.now(UTC)
    render.status = "deleted"
    db.commit()


def _get_render(db: Session, organization_id: str, render_id: str) -> Render:
    render = db.scalar(
        select(Render)
        .options(selectinload(Render.attempts))
        .where(
            Render.id == render_id,
            Render.organization_id == organization_id,
            Render.deleted_at.is_(None),
        )
    )
    if render is None:
        raise HTTPException(status_code=404, detail="Render not found")
    return render


TenantModel = TypeVar("TenantModel", Scene, Product, SceneSurface, Calibration)


def _tenant_entity(  # noqa: UP047 - Python 3.12 remains the supported minimum.
    db: Session,
    model: type[TenantModel],
    entity_id: str,
    organization_id: str,
) -> TenantModel:
    entity = db.scalar(
        select(model).where(
            model.id == entity_id,
            model.organization_id == organization_id,
        )
    )
    if entity is None:
        raise HTTPException(status_code=404, detail=f"{model.__name__} not found")
    return cast(TenantModel, entity)


def _render_response(render: Render, settings: Settings) -> RenderResponse:
    return RenderResponse(
        id=render.id,
        status=render.status,
        provider=render.provider,
        model=render.model,
        requested_size=render.requested_size,
        result_url=public_storage_url(render.result_path, settings),
        composition_url=public_storage_url(render.composition_path, settings),
        quality_score=render.quality_score,
        quality_scores=render.quality_scores,
        credit_charged=render.credit_charged,
        error=render.error,
        created_at=render.created_at,
        completed_at=render.completed_at,
        attempts=[
            RenderAttemptResponse(
                id=attempt.id,
                attempt_number=attempt.attempt_number,
                provider=attempt.provider,
                model=attempt.model,
                status=attempt.status,
                latency_ms=attempt.latency_ms,
                usage=attempt.usage,
                estimated_cost_usd=attempt.estimated_cost_usd,
                error=attempt.error,
            )
            for attempt in sorted(render.attempts, key=lambda item: item.attempt_number)
        ],
    )
