from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class UUIDTimestampMixin:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class SoftDeleteMixin:
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class User(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))


class Organization(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "organizations"
    name: Mapped[str] = mapped_column(String(160))
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)


class Membership(UUIDTimestampMixin, Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("organization_id", "user_id"),)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(24), default="owner")


class Product(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "products"
    __table_args__ = (
        CheckConstraint("width_cm > 0", name="ck_product_width"),
        CheckConstraint("height_cm > 0", name="ck_product_height"),
        CheckConstraint("depth_cm >= 0", name="ck_product_depth"),
        Index("ix_products_org_status", "organization_id", "status"),
    )
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    width_cm: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    height_cm: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    depth_cm: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    material: Mapped[str] = mapped_column(String(80))
    placement_type: Mapped[str] = mapped_column(String(32))
    lighting_profile: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="draft")
    buy_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    visual_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    assets: Mapped[list[ProductAsset]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    anchors: Mapped[list[ProductAnchor]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class ProductAsset(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "product_assets"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32), default="original")
    original_path: Mapped[str] = mapped_column(Text)
    sanitized_path: Mapped[str] = mapped_column(Text)
    thumbnail_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    cutout_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    mask_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    mime_type: Mapped[str] = mapped_column(String(80))
    width_px: Mapped[int] = mapped_column(Integer)
    height_px: Mapped[int] = mapped_column(Integer)
    size_bytes: Mapped[int] = mapped_column(Integer)
    product: Mapped[Product] = relationship(back_populates="assets")


class ProductAnchor(UUIDTimestampMixin, Base):
    __tablename__ = "product_anchors"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    anchor_type: Mapped[str] = mapped_column(String(24), default="bottom_center")
    x_normalized: Mapped[Decimal] = mapped_column(Numeric(6, 5), default=Decimal("0.5"))
    y_normalized: Mapped[Decimal] = mapped_column(Numeric(6, 5), default=Decimal("1"))
    product: Mapped[Product] = relationship(back_populates="anchors")


class Scene(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "scenes"
    __table_args__ = (Index("ix_scenes_org_expires", "organization_id", "expires_at"),)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    original_path: Mapped[str] = mapped_column(Text)
    sanitized_path: Mapped[str] = mapped_column(Text)
    thumbnail_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    mime_type: Mapped[str] = mapped_column(String(80))
    width_px: Mapped[int] = mapped_column(Integer)
    height_px: Mapped[int] = mapped_column(Integer)
    analysis: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="ready")
    consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SceneSurface(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "scene_surfaces"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    scene_id: Mapped[str] = mapped_column(
        ForeignKey("scenes.id", ondelete="CASCADE"), index=True
    )
    surface_type: Mapped[str] = mapped_column(String(32))
    polygon: Mapped[list[dict[str, float]]] = mapped_column(JSON)
    confidence: Mapped[Decimal] = mapped_column(Numeric(5, 4), default=Decimal("1"))
    source: Mapped[str] = mapped_column(String(24), default="manual")


class Calibration(UUIDTimestampMixin, Base):
    __tablename__ = "calibrations"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    scene_id: Mapped[str] = mapped_column(
        ForeignKey("scenes.id", ondelete="CASCADE"), index=True
    )
    surface_id: Mapped[str | None] = mapped_column(ForeignKey("scene_surfaces.id"), nullable=True)
    mode: Mapped[str] = mapped_column(String(24))
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON)
    pixels_per_cm: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    homography: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="calibrated")


class Placement(UUIDTimestampMixin, Base):
    __tablename__ = "placements"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    scene_id: Mapped[str] = mapped_column(ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    surface_id: Mapped[str | None] = mapped_column(ForeignKey("scene_surfaces.id"), nullable=True)
    calibration_id: Mapped[str | None] = mapped_column(ForeignKey("calibrations.id"), nullable=True)
    mode: Mapped[str] = mapped_column(String(24), default="quick")
    x_normalized: Mapped[Decimal] = mapped_column(Numeric(7, 6), default=Decimal("0.5"))
    y_normalized: Mapped[Decimal] = mapped_column(Numeric(7, 6), default=Decimal("0.75"))
    scale: Mapped[Decimal] = mapped_column(Numeric(8, 5), default=Decimal("0.22"))
    rotation_degrees: Mapped[Decimal] = mapped_column(Numeric(7, 3), default=Decimal("0"))
    lighting: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Render(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "renders"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key"),
        Index("ix_renders_org_status", "organization_id", "status"),
    )
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    placement_id: Mapped[str] = mapped_column(
        ForeignKey("placements.id", ondelete="CASCADE"), index=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(24), default="queued")
    quality: Mapped[str] = mapped_column(String(16), default="medium")
    requested_size: Mapped[str] = mapped_column(String(24))
    fidelity_mode: Mapped[str] = mapped_column(String(24), default="catalog")
    composition_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    protection_mask_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider: Mapped[str | None] = mapped_column(String(40), nullable=True)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    quality_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 4), nullable=True)
    quality_scores: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    credit_charged: Mapped[bool] = mapped_column(Boolean, default=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[list[RenderAttempt]] = relationship(
        back_populates="render", cascade="all, delete-orphan"
    )


class RenderAttempt(UUIDTimestampMixin, Base):
    __tablename__ = "render_attempts"
    __table_args__ = (UniqueConstraint("render_id", "attempt_number"),)
    render_id: Mapped[str] = mapped_column(
        ForeignKey("renders.id", ondelete="CASCADE"), index=True
    )
    attempt_number: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(80))
    quality: Mapped[str] = mapped_column(String(16))
    requested_size: Mapped[str] = mapped_column(String(24))
    input_image_count: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String(24))
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    usage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    render: Mapped[Render] = relationship(back_populates="attempts")


class CreditWallet(UUIDTimestampMixin, Base):
    __tablename__ = "credit_wallets"
    __table_args__ = (
        UniqueConstraint("organization_id"),
        CheckConstraint("balance >= 0", name="ck_wallet_non_negative"),
    )
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    balance: Mapped[int] = mapped_column(Integer, default=0)


class CreditTransaction(UUIDTimestampMixin, Base):
    __tablename__ = "credit_transactions"
    __table_args__ = (UniqueConstraint("organization_id", "idempotency_key"),)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    wallet_id: Mapped[str] = mapped_column(
        ForeignKey("credit_wallets.id", ondelete="CASCADE"), index=True
    )
    render_id: Mapped[str | None] = mapped_column(ForeignKey("renders.id"), nullable=True)
    amount: Mapped[int] = mapped_column(Integer)
    transaction_type: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(24), default="confirmed")
    idempotency_key: Mapped[str] = mapped_column(String(160))
    balance_after: Mapped[int] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)


class Subscription(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "subscriptions"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str | None] = mapped_column(String(160), nullable=True, unique=True)
    plan: Mapped[str] = mapped_column(String(40), default="starter")
    status: Mapped[str] = mapped_column(String(24), default="inactive")
    renews_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Widget(UUIDTimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "widgets"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    merchant_slug: Mapped[str] = mapped_column(String(120), index=True)
    allowed_origins: Mapped[list[str]] = mapped_column(JSON, default=list)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class AnalyticsEvent(UUIDTimestampMixin, Base):
    __tablename__ = "analytics_events"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    event_name: Mapped[str] = mapped_column(String(80), index=True)
    session_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    product_id: Mapped[str | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    properties: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class AuditLog(UUIDTimestampMixin, Base):
    __tablename__ = "audit_logs"
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    actor_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(100), index=True)
    entity_type: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Payment(UUIDTimestampMixin, Base):
    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("provider", "external_id"),
        UniqueConstraint("organization_id", "idempotency_key"),
    )
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str] = mapped_column(String(160))
    idempotency_key: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(24))
    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="TND")
    credits: Mapped[int] = mapped_column(Integer)
    checkout_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    credited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

