from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

PlacementType = Literal["table", "nightstand", "shelf", "niche", "wall", "floor"]


class CamelModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=lambda name: "".join(
            word.capitalize() if index else word
            for index, word in enumerate(name.split("_"))
        ),
    )


class ProductCreate(CamelModel):
    name: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=5_000)
    sku: str | None = Field(default=None, max_length=100)
    width_cm: Decimal = Field(gt=0, le=1_000)
    height_cm: Decimal = Field(gt=0, le=1_000)
    depth_cm: Decimal = Field(ge=0, le=1_000)
    material: str = Field(min_length=2, max_length=80)
    placement_type: PlacementType
    lighting_profile: dict[str, Any] = Field(default_factory=dict)
    buy_url: HttpUrl | None = None


class ProductUpdate(CamelModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    description: str | None = Field(default=None, max_length=5_000)
    width_cm: Decimal | None = Field(default=None, gt=0, le=1_000)
    height_cm: Decimal | None = Field(default=None, gt=0, le=1_000)
    depth_cm: Decimal | None = Field(default=None, ge=0, le=1_000)
    material: str | None = Field(default=None, min_length=2, max_length=80)
    placement_type: PlacementType | None = None
    buy_url: HttpUrl | None = None


class AnchorCreate(CamelModel):
    anchor_type: Literal["bottom_center", "center", "wall_center"] = "bottom_center"
    x_normalized: Decimal = Field(ge=0, le=1, default=Decimal("0.5"))
    y_normalized: Decimal = Field(ge=0, le=1, default=Decimal("1"))


class ProductResponse(CamelModel):
    id: str
    name: str
    description: str
    sku: str | None
    width_cm: Decimal
    height_cm: Decimal
    depth_cm: Decimal
    material: str
    placement_type: str
    status: str
    buy_url: str | None
    asset_url: str | None = None
    cutout_url: str | None = None
    created_at: datetime


class SceneResponse(CamelModel):
    id: str
    status: str
    image_url: str
    thumbnail_url: str | None
    width_px: int
    height_px: int
    analysis: dict[str, Any]
    expires_at: datetime
    created_at: datetime


class SurfaceCreate(CamelModel):
    surface_type: PlacementType
    polygon: list[dict[str, float]] = Field(min_length=4, max_length=16)

    @field_validator("polygon")
    @classmethod
    def normalized_points(cls, points: list[dict[str, float]]) -> list[dict[str, float]]:
        for point in points:
            if set(point) != {"x", "y"}:
                raise ValueError("Each point must contain x and y")
            if not 0 <= point["x"] <= 1 or not 0 <= point["y"] <= 1:
                raise ValueError("Surface points must be normalized between 0 and 1")
        return points


class CalibrationCreate(CamelModel):
    mode: Literal["quick", "wall", "surface"]
    surface_id: str | None = None
    parameters: dict[str, Any]


class PlacementCreate(CamelModel):
    scene_id: str
    product_id: str
    surface_id: str | None = None
    calibration_id: str | None = None
    mode: Literal["quick", "wall", "surface"] = "quick"
    x_normalized: Decimal = Field(ge=0, le=1, default=Decimal("0.5"))
    y_normalized: Decimal = Field(ge=0, le=1, default=Decimal("0.74"))
    scale: Decimal = Field(gt=0.03, le=0.9, default=Decimal("0.22"))
    rotation_degrees: Decimal = Field(ge=-180, le=180, default=Decimal("0"))
    lighting: dict[str, Any] = Field(
        default_factory=lambda: {
            "direction": "left",
            "temperature": "neutral",
            "hardness": "soft",
        }
    )


class RenderCreate(CamelModel):
    placement: PlacementCreate
    idempotency_key: str = Field(min_length=12, max_length=128)
    quality: Literal["low", "medium", "high"] = "medium"
    fidelity_mode: Literal["catalog", "photorealistic"] = "catalog"


class RenderAttemptResponse(CamelModel):
    id: str
    attempt_number: int
    provider: str
    model: str
    status: str
    latency_ms: int
    usage: dict[str, Any]
    estimated_cost_usd: Decimal
    error: str | None


class RenderResponse(CamelModel):
    id: str
    status: str
    provider: str | None
    model: str | None
    requested_size: str
    result_url: str | None
    composition_url: str | None
    quality_score: Decimal | None
    quality_scores: dict[str, Any]
    credit_charged: bool
    error: str | None
    created_at: datetime
    completed_at: datetime | None
    attempts: list[RenderAttemptResponse] = Field(default_factory=list)


class CheckoutCreate(CamelModel):
    pack: Literal["starter", "studio", "scale"]
    idempotency_key: str = Field(min_length=12, max_length=160)
    success_url: HttpUrl | None = None
    cancel_url: HttpUrl | None = None


class WidgetCreate(CamelModel):
    name: str = Field(min_length=2, max_length=120)
    merchant_slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    allowed_origins: list[str] = Field(default_factory=list)
    configuration: dict[str, Any] = Field(default_factory=dict)


class AnalyticsCreate(CamelModel):
    event: Literal[
        "visualizer_opened",
        "room_uploaded",
        "surface_selected",
        "calibration_started",
        "calibration_completed",
        "placement_adjusted",
        "render_requested",
        "render_succeeded",
        "render_failed",
        "result_downloaded",
        "result_shared",
        "add_to_cart_clicked",
    ]
    session_id: str | None = Field(default=None, max_length=100)
    product_id: str | None = None
    properties: dict[str, bool | int | float | str | None] = Field(default_factory=dict)

