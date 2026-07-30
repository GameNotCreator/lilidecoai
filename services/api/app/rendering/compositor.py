from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter


@dataclass(frozen=True)
class CompositionResult:
    composition_path: Path
    mask_path: Path
    product_bbox: tuple[int, int, int, int]
    normalized_bbox: tuple[float, float, float, float]


def compose_product(
    scene_path: str | Path,
    cutout_path: str | Path,
    *,
    output_directory: Path,
    render_id: str,
    x_normalized: float,
    y_normalized: float,
    scale: float,
    rotation_degrees: float,
    lighting: dict[str, object],
) -> CompositionResult:
    output_directory.mkdir(parents=True, exist_ok=True)
    composition_path = output_directory / f"{render_id}.composition.webp"
    mask_path = output_directory / f"{render_id}.edit-mask.png"

    with Image.open(scene_path) as scene_source, Image.open(cutout_path) as product_source:
        scene = scene_source.convert("RGBA")
        product = product_source.convert("RGBA")
        target_width = max(32, round(scene.width * scale))
        target_height = max(32, round(target_width * product.height / product.width))
        product = product.resize((target_width, target_height), Image.Resampling.LANCZOS)

        temperature = str(lighting.get("temperature", "neutral"))
        if temperature == "warm":
            red, green, blue, alpha = product.split()
            red = ImageEnhance.Brightness(red).enhance(1.035)
            blue = ImageEnhance.Brightness(blue).enhance(0.975)
            product = Image.merge("RGBA", (red, green, blue, alpha))
        elif temperature == "cool":
            red, green, blue, alpha = product.split()
            red = ImageEnhance.Brightness(red).enhance(0.975)
            blue = ImageEnhance.Brightness(blue).enhance(1.035)
            product = Image.merge("RGBA", (red, green, blue, alpha))

        if rotation_degrees:
            product = product.rotate(
                -rotation_degrees,
                resample=Image.Resampling.BICUBIC,
                expand=True,
            )

        left = round(scene.width * x_normalized - product.width / 2)
        top = round(scene.height * y_normalized - product.height)
        left = min(max(left, -product.width // 3), scene.width - product.width * 2 // 3)
        top = min(max(top, -product.height // 3), scene.height - product.height * 2 // 3)
        bbox = (left, top, left + product.width, top + product.height)

        alpha = product.getchannel("A")
        shadow = Image.new("RGBA", scene.size, (0, 0, 0, 0))
        shadow_shape = Image.new("L", scene.size, 0)
        shadow_left = left + max(3, product.width // 30)
        shadow_top = top + max(6, product.height // 24)
        shadow_shape.paste(alpha, (shadow_left, shadow_top))
        blur_radius = max(3, min(scene.size) // 140)
        shadow_shape = shadow_shape.filter(ImageFilter.GaussianBlur(blur_radius))
        hardness = str(lighting.get("hardness", "soft"))
        opacity = 52 if hardness == "soft" else 76 if hardness == "balanced" else 98
        shadow.putalpha(shadow_shape.point(lambda pixel: pixel * opacity // 255))

        composed = Image.alpha_composite(scene, shadow)
        composed.alpha_composite(product, (left, top))
        composed.convert("RGB").save(composition_path, "WEBP", quality=94, method=6)

        allowed = Image.new("L", scene.size, 0)
        allowed.paste(alpha, (left, top))
        allowed = allowed.filter(ImageFilter.MaxFilter(19))
        allowed = ImageEnhance.Brightness(allowed).enhance(0.78)
        allowed = ImageChops.lighter(allowed, shadow_shape)
        allowed = allowed.filter(ImageFilter.GaussianBlur(2.2))
        protection_alpha = allowed.point(lambda pixel: 255 - pixel)
        api_mask = Image.new("RGBA", scene.size, (255, 255, 255, 255))
        api_mask.putalpha(protection_alpha)
        api_mask.save(mask_path, "PNG", optimize=True)

        normalized_bbox = (
            left / scene.width,
            top / scene.height,
            (left + product.width) / scene.width,
            (top + product.height) / scene.height,
        )
        return CompositionResult(
            composition_path=composition_path,
            mask_path=mask_path,
            product_bbox=bbox,
            normalized_bbox=normalized_bbox,
        )


def overlay_catalog_product(
    generated_path: str | Path,
    cutout_path: str | Path,
    normalized_bbox: tuple[float, float, float, float],
    destination_path: str | Path,
) -> None:
    with Image.open(generated_path) as generated_source, Image.open(cutout_path) as cutout_source:
        generated = generated_source.convert("RGBA")
        cutout = cutout_source.convert("RGBA")
        left = round(normalized_bbox[0] * generated.width)
        top = round(normalized_bbox[1] * generated.height)
        right = round(normalized_bbox[2] * generated.width)
        bottom = round(normalized_bbox[3] * generated.height)
        target_size = (max(1, right - left), max(1, bottom - top))
        cutout = cutout.resize(target_size, Image.Resampling.LANCZOS)
        generated.alpha_composite(cutout, (left, top))
        generated.convert("RGB").save(destination_path, "WEBP", quality=90, method=6)
