import hashlib
import hmac
import io
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from uuid import uuid4

from PIL import Image, ImageChops, ImageFilter

from .config import Settings


@dataclass(frozen=True)
class ProcessedImage:
    original_path: Path
    sanitized_path: Path
    thumbnail_path: Path
    width: int
    height: int
    size_bytes: int
    fingerprint: str


def process_image(
    content: bytes,
    *,
    namespace: str,
    settings: Settings,
) -> ProcessedImage:
    image_id = str(uuid4())
    directory = settings.storage_path / namespace
    directory.mkdir(parents=True, exist_ok=True)
    original_path = directory / f"{image_id}.upload"
    sanitized_path = directory / f"{image_id}.webp"
    thumbnail_path = directory / f"{image_id}.thumb.webp"

    original_path.write_bytes(content)
    with Image.open(io.BytesIO(content)) as source:
        # Re-encoding strips EXIF and other source metadata.
        clean = source.convert("RGBA")
        clean.save(sanitized_path, "WEBP", quality=94, method=6)
        thumbnail = clean.copy()
        thumbnail.thumbnail((640, 640), Image.Resampling.LANCZOS)
        thumbnail.convert("RGB").save(thumbnail_path, "WEBP", quality=86, method=6)
        fingerprint = hashlib.sha256(clean.tobytes()).hexdigest()
        width, height = clean.size

    return ProcessedImage(
        original_path=original_path,
        sanitized_path=sanitized_path,
        thumbnail_path=thumbnail_path,
        width=width,
        height=height,
        size_bytes=len(content),
        fingerprint=fingerprint,
    )


def create_simple_cutout(source_path: Path) -> tuple[Path, Path]:
    """Deterministic development segmentation with a removable near-white backdrop."""
    cutout_path = source_path.with_name(f"{source_path.stem}.cutout.png")
    mask_path = source_path.with_name(f"{source_path.stem}.mask.png")
    with Image.open(source_path) as source:
        image = source.convert("RGBA")
        rgb = image.convert("RGB")
        white = Image.new("RGB", image.size, (255, 255, 255))
        difference = ImageChops.difference(rgb, white).convert("L")
        # Keep everything sufficiently different from white. Transparent PNGs retain alpha.
        foreground = difference.point(lambda pixel: 0 if pixel < 24 else 255)
        alpha_extrema = cast(tuple[int, int], image.getchannel("A").getextrema())
        if alpha_extrema[0] < 255:
            foreground = ImageChops.multiply(foreground, image.getchannel("A"))
        foreground = foreground.filter(ImageFilter.GaussianBlur(0.8))
        output = image.copy()
        output.putalpha(foreground)
        output.save(cutout_path, "PNG", optimize=True)
        foreground.save(mask_path, "PNG", optimize=True)
    return cutout_path, mask_path


def public_storage_url(path: str | Path | None, settings: Settings) -> str | None:
    if path is None:
        return None
    relative = Path(path).resolve().relative_to(settings.storage_path.resolve())
    relative_path = relative.as_posix()
    base_url = f"{settings.public_api_url}/storage/{relative_path}"
    if settings.demo_mode:
        return base_url
    expires = int(time.time()) + settings.signed_url_ttl_seconds
    signature = hmac.new(
        settings.signed_url_secret.encode(),
        f"{relative_path}:{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{base_url}?expires={expires}&signature={signature}"


def verify_storage_signature(
    relative_path: str,
    expires: int,
    signature: str,
    settings: Settings,
) -> bool:
    if expires < int(time.time()):
        return False
    expected = hmac.new(
        settings.signed_url_secret.encode(),
        f"{relative_path}:{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
