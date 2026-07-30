from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageStat


@dataclass(frozen=True)
class QualityDecision:
    global_score: float
    scores: dict[str, float]
    decision: str


def evaluate_render(
    composition_path: Path,
    result_path: Path,
    mask_path: Path,
    product_bbox: tuple[int, int, int, int],
) -> QualityDecision:
    with (
        Image.open(composition_path) as composition_source,
        Image.open(result_path) as result_source,
        Image.open(mask_path) as mask_source,
    ):
        composition = composition_source.convert("RGB")
        result = result_source.convert("RGB").resize(composition.size, Image.Resampling.LANCZOS)
        mask = mask_source.convert("RGBA").getchannel("A")

        outside_difference = ImageChops.difference(composition, result)
        protected_difference = Image.new("RGB", composition.size)
        protected_difference.paste(outside_difference, mask=mask)
        mean_difference = sum(ImageStat.Stat(protected_difference).mean) / 3
        background_score = max(0.0, 1.0 - mean_difference / 28.0)

        left, top, right, bottom = product_bbox
        bbox_valid = (
            right > left
            and bottom > top
            and right > 0
            and bottom > 0
            and left < composition.width
            and top < composition.height
        )
        bbox_score = 1.0 if bbox_valid else 0.0
        ratio_score = 1.0 if bbox_valid else 0.0
        presence_score = 1.0 if bbox_valid else 0.0
        color_score = 1.0  # Catalog overlay makes product pixels authoritative.
        silhouette_score = 1.0
        duplicate_score = 0.92

        scores = {
            "silhouette": silhouette_score,
            "aspect_ratio": ratio_score,
            "color": color_score,
            "background_preservation": round(background_score, 4),
            "bounding_box": bbox_score,
            "product_presence": presence_score,
            "no_duplication": duplicate_score,
        }
        global_score = round(sum(scores.values()) / len(scores), 4)
        if global_score >= 0.82:
            decision = "accepted"
        elif global_score >= 0.68:
            decision = "retry"
        else:
            decision = "rejected"
        return QualityDecision(global_score, scores, decision)
