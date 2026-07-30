from __future__ import annotations

import base64
import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from ..config import Settings


@dataclass(frozen=True)
class GenerationRequest:
    scene_path: Path
    product_cutout_path: Path
    composition_path: Path
    protection_mask_path: Path
    output_path: Path
    prompt: str
    quality: str
    size: str
    idempotency_key: str


@dataclass(frozen=True)
class GenerationResult:
    provider: str
    model: str
    status: str
    duration_ms: int
    estimated_cost_usd: float
    usage: dict[str, object] = field(default_factory=dict)
    error: str | None = None


class ImageGenerationProvider(Protocol):
    name: str
    model: str

    def is_available(self) -> bool: ...

    def generate(self, request: GenerationRequest) -> GenerationResult: ...


class MockImageProvider:
    name = "mock"
    model = "deterministic-compositor-v1"

    def is_available(self) -> bool:
        return True

    def generate(self, request: GenerationRequest) -> GenerationResult:
        started = time.perf_counter()
        shutil.copyfile(request.composition_path, request.output_path)
        return GenerationResult(
            provider=self.name,
            model=self.model,
            status="succeeded",
            duration_ms=round((time.perf_counter() - started) * 1_000),
            estimated_cost_usd=0,
            usage={"mode": "mock", "input_images": 3},
        )


class OpenAIImageProvider:
    name = "openai"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = settings.openai_model

    def is_available(self) -> bool:
        return self.settings.use_openai

    def generate(self, request: GenerationRequest) -> GenerationResult:
        started = time.perf_counter()
        if not self.is_available():
            return GenerationResult(
                provider=self.name,
                model=self.model,
                status="failed",
                duration_ms=0,
                estimated_cost_usd=0,
                error="OPENAI_API_KEY is not configured or demo mode is enabled",
            )

        estimate = estimate_openai_cost(request.quality, request.size)
        if estimate > self.settings.openai_max_cost_usd:
            return GenerationResult(
                provider=self.name,
                model=self.model,
                status="failed",
                duration_ms=0,
                estimated_cost_usd=estimate,
                error="Estimated request cost exceeds OPENAI_MAX_COST_USD",
            )

        try:
            files = [
                (
                    "image[]",
                    ("room.webp", request.scene_path.read_bytes(), "image/webp"),
                ),
                (
                    "image[]",
                    ("product.png", request.product_cutout_path.read_bytes(), "image/png"),
                ),
                (
                    "image[]",
                    ("composition.webp", request.composition_path.read_bytes(), "image/webp"),
                ),
                (
                    "mask",
                    ("edit-mask.png", request.protection_mask_path.read_bytes(), "image/png"),
                ),
            ]
            data = {
                "model": self.model,
                "prompt": request.prompt,
                "quality": request.quality,
                "size": request.size,
                "background": "opaque",
                "output_format": "webp",
                "output_compression": "90",
            }
            with httpx.Client(timeout=self.settings.openai_timeout_seconds) as client:
                response = client.post(
                    f"{self.settings.openai_base_url}/images/edits",
                    headers={
                        "Authorization": f"Bearer {self.settings.openai_api_key}",
                        "Idempotency-Key": request.idempotency_key,
                    },
                    data=data,
                    files=files,
                )
                response.raise_for_status()
                payload = response.json()
            encoded = payload["data"][0]["b64_json"]
            request.output_path.write_bytes(base64.b64decode(encoded))
            usage = payload.get("usage", {})
            return GenerationResult(
                provider=self.name,
                model=self.model,
                status="succeeded",
                duration_ms=round((time.perf_counter() - started) * 1_000),
                estimated_cost_usd=estimate,
                usage=usage if isinstance(usage, dict) else {"raw": json.dumps(usage)},
            )
        except (httpx.HTTPError, KeyError, ValueError, OSError) as exc:
            return GenerationResult(
                provider=self.name,
                model=self.model,
                status="failed",
                duration_ms=round((time.perf_counter() - started) * 1_000),
                estimated_cost_usd=estimate,
                error=_safe_provider_error(exc),
            )


def choose_provider(settings: Settings) -> ImageGenerationProvider:
    openai = OpenAIImageProvider(settings)
    return openai if openai.is_available() else MockImageProvider()


def estimate_openai_cost(quality: str, size: str) -> float:
    # Output-only guardrail estimate from the official price table as of 2026-07.
    # Actual usage and estimated aggregate cost are persisted for every attempt.
    price_table = {
        "low": {"1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005},
        "medium": {"1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041},
        "high": {"1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165},
    }
    output_estimate = price_table.get(quality, price_table["medium"]).get(size, 0.053)
    return round(output_estimate + 0.025, 6)


def _safe_provider_error(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"OpenAI returned HTTP {error.response.status_code}"
    return error.__class__.__name__

