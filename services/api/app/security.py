import hashlib
import hmac
import io
import time
from collections import defaultdict, deque
from pathlib import Path
from threading import Lock

from fastapi import HTTPException, Request, UploadFile, status
from PIL import Image, UnidentifiedImageError

from .config import Settings

ALLOWED_FORMATS = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}


async def read_validated_image(file: UploadFile, settings: Settings) -> tuple[bytes, str, int, int]:
    content = await file.read(settings.max_upload_bytes + 1)
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds the configured size limit")
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded file is empty")
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
        with Image.open(io.BytesIO(content)) as image:
            image_format = image.format or ""
            mime = ALLOWED_FORMATS.get(image_format)
            if mime is None:
                raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP are accepted")
            if min(image.size) < settings.min_image_dimension:
                raise HTTPException(
                    status_code=422,
                    detail=f"Images must be at least {settings.min_image_dimension}px on each side",
                )
            return content, mime, image.width, image.height
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=415, detail="The file is not a valid image") from exc


def safe_unlink(path: str | Path, storage_root: Path) -> None:
    candidate = Path(path).resolve()
    root = storage_root.resolve()
    if candidate == root or root not in candidate.parents:
        raise ValueError("Refusing to delete outside storage root")
    candidate.unlink(missing_ok=True)


def verify_hmac_signature(payload: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.removeprefix("sha256="))


def hash_ip(ip: str | None, secret: str) -> str | None:
    if not ip:
        return None
    return hmac.new(secret.encode(), ip.encode(), hashlib.sha256).hexdigest()


class InMemoryRateLimiter:
    """Small-process fallback. Production deployments should set Redis and share state."""

    def __init__(self, limit: int = 120, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._requests: defaultdict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, request: Request) -> None:
        identity = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with self._lock:
            bucket = self._requests[identity]
            while bucket and bucket[0] <= now - self.window_seconds:
                bucket.popleft()
            if len(bucket) >= self.limit:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Rate limit exceeded",
                )
            bucket.append(now)

