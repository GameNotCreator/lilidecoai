from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..credits import capture_credit, release_credit
from ..models import (
    Placement,
    Product,
    ProductAsset,
    Render,
    RenderAttempt,
    Scene,
)
from .compositor import compose_product, overlay_catalog_product
from .providers import GenerationRequest, choose_provider
from .quality import evaluate_render


def execute_render(db: Session, render: Render, settings: Settings) -> Render:
    placement = db.get(Placement, render.placement_id)
    if placement is None:
        return _fail(db, render, settings, "Placement not found")
    scene = db.get(Scene, placement.scene_id)
    product = db.get(Product, placement.product_id)
    asset = db.scalar(
        select(ProductAsset).where(
            ProductAsset.product_id == placement.product_id,
            ProductAsset.organization_id == render.organization_id,
            ProductAsset.deleted_at.is_(None),
        ).order_by(ProductAsset.created_at.desc())
    )
    if scene is None or product is None or asset is None or not asset.cutout_path:
        return _fail(db, render, settings, "Scene or prepared product asset is missing")

    render.status = "processing"
    db.flush()
    output_directory = settings.storage_path / "renders"
    composition = compose_product(
        scene.sanitized_path,
        asset.cutout_path,
        output_directory=output_directory,
        render_id=render.id,
        x_normalized=float(placement.x_normalized),
        y_normalized=float(placement.y_normalized),
        scale=float(placement.scale),
        rotation_degrees=float(placement.rotation_degrees),
        lighting=placement.lighting,
    )
    render.composition_path = str(composition.composition_path)
    render.protection_mask_path = str(composition.mask_path)
    provider = choose_provider(settings)
    raw_result_path = output_directory / f"{render.id}.provider.webp"
    final_result_path = output_directory / f"{render.id}.webp"
    prompt = build_prompt(product, placement, render.fidelity_mode)
    max_attempts = settings.openai_max_retries + 1 if provider.name == "openai" else 1

    last_error = "Provider failed"
    for attempt_number in range(1, max_attempts + 1):
        result = provider.generate(
            GenerationRequest(
                scene_path=Path(scene.sanitized_path),
                product_cutout_path=Path(asset.cutout_path),
                composition_path=composition.composition_path,
                protection_mask_path=composition.mask_path,
                output_path=raw_result_path,
                prompt=prompt,
                quality=render.quality,
                size=render.requested_size,
                idempotency_key=f"{render.idempotency_key}:attempt:{attempt_number}",
            )
        )
        attempt = RenderAttempt(
            render_id=render.id,
            attempt_number=attempt_number,
            provider=result.provider,
            model=result.model,
            quality=render.quality,
            requested_size=render.requested_size,
            input_image_count=3,
            status=result.status,
            latency_ms=result.duration_ms,
            usage=result.usage,
            estimated_cost_usd=Decimal(str(result.estimated_cost_usd)),
            error=result.error,
        )
        db.add(attempt)
        render.provider = result.provider
        render.model = result.model
        db.flush()

        if result.status != "succeeded":
            last_error = result.error or "Provider failed"
            continue

        overlay_catalog_product(
            raw_result_path,
            asset.cutout_path,
            composition.normalized_bbox,
            final_result_path,
        )
        quality = evaluate_render(
            composition.composition_path,
            final_result_path,
            composition.mask_path,
            composition.product_bbox,
        )
        if quality.decision == "retry" and attempt_number < max_attempts:
            attempt.status = "quality_retry"
            continue
        if quality.decision == "rejected":
            attempt.status = "quality_rejected"
            last_error = f"Quality gate rejected output ({quality.global_score})"
            continue

        render.result_path = str(final_result_path)
        render.quality_score = Decimal(str(quality.global_score))
        render.quality_scores = quality.scores
        render.status = "succeeded"
        render.completed_at = datetime.now(UTC)
        capture_credit(db, render.organization_id, render.id)
        render.credit_charged = True
        db.commit()
        db.refresh(render)
        return render

    return _fail(db, render, settings, last_error)


def select_size(width: int, height: int) -> str:
    ratio = width / height
    if ratio > 1.15:
        return "1536x1024"
    if ratio < 0.87:
        return "1024x1536"
    return "1024x1024"


def build_prompt(product: Product, placement: Placement, fidelity_mode: str) -> str:
    lighting = placement.lighting
    return (
        "Edit only the transparent region of the supplied mask. "
        "The room photograph is the immutable background. The transparent PNG is the exact "
        f"catalog product: a {product.material} object measuring {product.width_cm} cm wide, "
        f"{product.height_cm} cm high and {product.depth_cm} cm deep. "
        "The deterministic composition is the source of truth for scale, perspective, position, "
        "silhouette, colors, motifs and proportions. Add only physically plausible contact shadow, "
        "subtle edge integration and local reflected light. Never duplicate, reshape, recolor, "
        "move, resize or redesign the product. Preserve every room pixel outside the mask. "
        f"Placement mode: {placement.mode}. Light direction: {lighting.get('direction', 'left')}; "
        f"temperature: {lighting.get('temperature', 'neutral')}; "
        f"hardness: {lighting.get('hardness', 'soft')}. Fidelity mode: {fidelity_mode}."
    )


def _fail(db: Session, render: Render, settings: Settings, error: str) -> Render:
    render.status = "failed"
    render.error = error
    render.completed_at = datetime.now(UTC)
    release_credit(db, render.organization_id, render.id)
    render.credit_charged = False
    db.commit()
    db.refresh(render)
    return render

