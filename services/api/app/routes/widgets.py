from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import Tenant
from ..config import Settings, get_settings
from ..database import get_db
from ..models import AnalyticsEvent, AuditLog, Organization, Product, Render, RenderAttempt, Widget
from ..schemas import AnalyticsCreate, WidgetCreate

router = APIRouter(tags=["widgets", "analytics"])
Db = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.post("/widgets", status_code=status.HTTP_201_CREATED)
def create_widget(payload: WidgetCreate, db: Db, tenant: Tenant) -> dict[str, object]:
    widget = Widget(
        organization_id=tenant.organization_id,
        name=payload.name,
        merchant_slug=payload.merchant_slug,
        allowed_origins=payload.allowed_origins,
        configuration=payload.configuration,
    )
    db.add(widget)
    db.commit()
    db.refresh(widget)
    return _widget(widget)


@router.patch("/widgets/{widget_id}")
def update_widget(
    widget_id: str,
    payload: WidgetCreate,
    db: Db,
    tenant: Tenant,
) -> dict[str, object]:
    widget = db.scalar(
        select(Widget).where(
            Widget.id == widget_id,
            Widget.organization_id == tenant.organization_id,
            Widget.deleted_at.is_(None),
        )
    )
    if widget is None:
        raise HTTPException(status_code=404, detail="Widget not found")
    widget.name = payload.name
    widget.merchant_slug = payload.merchant_slug
    widget.allowed_origins = payload.allowed_origins
    widget.configuration = payload.configuration
    db.commit()
    db.refresh(widget)
    return _widget(widget)


@router.get("/visualizer/{merchant_slug}/{product_id}")
def visualizer_configuration(
    merchant_slug: str,
    product_id: str,
    db: Db,
    settings: AppSettings,
) -> dict[str, object]:
    organization = db.scalar(
        select(Organization).where(
            Organization.slug == merchant_slug,
            Organization.deleted_at.is_(None),
        )
    )
    if organization is None:
        raise HTTPException(status_code=404, detail="Merchant not found")
    product = db.scalar(
        select(Product).where(
            Product.id == product_id,
            Product.organization_id == organization.id,
            Product.status == "ready",
            Product.deleted_at.is_(None),
        )
    )
    widget = db.scalar(
        select(Widget).where(
            Widget.organization_id == organization.id,
            Widget.merchant_slug == merchant_slug,
            Widget.active.is_(True),
            Widget.deleted_at.is_(None),
        )
    )
    if product is None or widget is None:
        raise HTTPException(status_code=404, detail="Visualizer is unavailable")
    return {
        "merchant": {"name": organization.name, "slug": organization.slug},
        "product": {"id": product.id, "name": product.name, "buyUrl": product.buy_url},
        "configuration": widget.configuration,
        "demoMode": settings.demo_mode,
    }


@router.post("/analytics", status_code=status.HTTP_202_ACCEPTED)
def create_analytics_event(
    payload: AnalyticsCreate,
    request: Request,
    db: Db,
    tenant: Tenant,
) -> dict[str, bool]:
    serialized = str(payload.properties)
    if "data:image" in serialized or len(serialized) > 8_192:
        raise HTTPException(status_code=422, detail="Analytics payload contains prohibited data")
    db.add(
        AnalyticsEvent(
            organization_id=tenant.organization_id,
            event_name=payload.event,
            session_id=payload.session_id,
            product_id=payload.product_id,
            properties=payload.properties,
        )
    )
    db.commit()
    return {"accepted": True}


@router.get("/admin/overview")
def admin_overview(db: Db, tenant: Tenant) -> dict[str, object]:
    if tenant.role not in {"owner", "admin", "platform_admin"}:
        raise HTTPException(status_code=403, detail="Admin role required")
    render_count = db.scalar(
        select(func.count(Render.id)).where(Render.organization_id == tenant.organization_id)
    )
    succeeded = db.scalar(
        select(func.count(Render.id)).where(
            Render.organization_id == tenant.organization_id,
            Render.status == "succeeded",
        )
    )
    attempts = db.scalars(
        select(RenderAttempt)
        .join(Render, Render.id == RenderAttempt.render_id)
        .where(Render.organization_id == tenant.organization_id)
        .order_by(RenderAttempt.created_at.desc())
        .limit(20)
    ).all()
    total_cost = sum(float(attempt.estimated_cost_usd) for attempt in attempts)
    return {
        "renders": render_count or 0,
        "succeeded": succeeded or 0,
        "successRate": round((succeeded or 0) / max(render_count or 0, 1), 3),
        "recentEstimatedCostUsd": round(total_cost, 4),
        "attempts": [
            {
                "id": attempt.id,
                "provider": attempt.provider,
                "model": attempt.model,
                "status": attempt.status,
                "latencyMs": attempt.latency_ms,
                "estimatedCostUsd": attempt.estimated_cost_usd,
                "createdAt": attempt.created_at,
            }
            for attempt in attempts
        ],
    }


@router.get("/admin/audit")
def audit_logs(db: Db, tenant: Tenant) -> list[dict[str, object]]:
    if tenant.role not in {"owner", "admin", "platform_admin"}:
        raise HTTPException(status_code=403, detail="Admin role required")
    logs = db.scalars(
        select(AuditLog)
        .where(AuditLog.organization_id == tenant.organization_id)
        .order_by(AuditLog.created_at.desc())
        .limit(100)
    ).all()
    return [
        {
            "id": log.id,
            "action": log.action,
            "entityType": log.entity_type,
            "entityId": log.entity_id,
            "details": log.details,
            "createdAt": log.created_at,
        }
        for log in logs
    ]


def _widget(widget: Widget) -> dict[str, object]:
    return {
        "id": widget.id,
        "name": widget.name,
        "merchantSlug": widget.merchant_slug,
        "allowedOrigins": widget.allowed_origins,
        "configuration": widget.configuration,
        "active": widget.active,
    }

