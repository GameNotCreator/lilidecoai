"""Redis worker entrypoint.

The MVP executes demo jobs synchronously. This process is intentionally small:
it proves the queue boundary and imports the same idempotent pipeline used by
the API. A production deployment can enqueue JSON payloads on `renders`.
"""

import json
import sys
from pathlib import Path
from typing import cast

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from app.config import get_settings
from app.database import SessionLocal
from app.models import Render
from app.rendering.pipeline import execute_render
from redis import Redis


def run() -> None:
    settings = get_settings()
    if not settings.redis_url:
        raise RuntimeError("REDIS_URL is required to run the asynchronous worker")
    client = Redis.from_url(settings.redis_url)
    while True:
        item = cast(list[bytes] | None, client.blpop(["renders"], timeout=10))
        if item is None:
            continue
        payload = json.loads(item[1])
        with SessionLocal() as db:
            render = db.get(Render, payload["render_id"])
            if render and render.status in {"queued", "processing"}:
                execute_render(db, render, settings)


if __name__ == "__main__":
    run()
