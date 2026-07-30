from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal
from app.models import Scene
from app.purge import purge_expired_scenes

from .helpers import image_bytes


def test_wall_and_surface_calibration(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    scene = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "true"},
    ).json()
    wall = client.post(
        f"/v1/scenes/{scene['id']}/calibrate",
        headers=tenant_headers,
        json={
            "mode": "wall",
            "parameters": {
                "start": {"x": 0.25, "y": 0.5},
                "end": {"x": 0.75, "y": 0.5},
                "realLengthCm": 100,
            },
        },
    )
    assert wall.status_code == 201
    assert float(wall.json()["pixelsPerCm"]) == pytest.approx(4)
    assert wall.json()["label"] == "Échelle calibrée"

    surface = client.post(
        f"/v1/scenes/{scene['id']}/calibrate",
        headers=tenant_headers,
        json={
            "mode": "surface",
            "parameters": {
                "corners": [
                    {"x": 0.2, "y": 0.5},
                    {"x": 0.8, "y": 0.5},
                    {"x": 0.9, "y": 0.85},
                    {"x": 0.1, "y": 0.85},
                ],
                "widthCm": 120,
                "depthCm": 80,
            },
        },
    )
    assert surface.status_code == 201, surface.text
    assert len(surface.json()["homography"]) == 9


def test_degenerate_surface_is_rejected(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    scene = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "true"},
    ).json()
    response = client.post(
        f"/v1/scenes/{scene['id']}/calibrate",
        headers=tenant_headers,
        json={
            "mode": "surface",
            "parameters": {
                "corners": [
                    {"x": 0.1, "y": 0.5},
                    {"x": 0.2, "y": 0.5},
                    {"x": 0.3, "y": 0.5},
                    {"x": 0.4, "y": 0.5},
                ],
                "widthCm": 100,
                "depthCm": 50,
            },
        },
    )
    assert response.status_code == 422


def test_expired_scene_files_are_purged(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    payload = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "true"},
    ).json()
    with SessionLocal() as db:
        scene = db.scalar(select(Scene).where(Scene.id == payload["id"]))
        assert scene is not None
        paths = [
            Path(scene.original_path),
            Path(scene.sanitized_path),
            Path(scene.thumbnail_path or ""),
        ]
        scene.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
        assert purge_expired_scenes(db, get_settings()) == 1
        db.refresh(scene)
        assert scene.status == "purged"
    assert all(not path.exists() for path in paths)
