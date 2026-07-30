import math
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Tenant
from ..config import Settings, get_settings
from ..database import get_db
from ..models import Calibration, Scene, SceneSurface
from ..schemas import CalibrationCreate, SceneResponse, SurfaceCreate
from ..security import read_validated_image
from ..storage import process_image, public_storage_url

router = APIRouter(prefix="/scenes", tags=["scenes"])
Db = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.post("", response_model=SceneResponse, status_code=status.HTTP_201_CREATED)
async def create_scene(
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
    file: Annotated[UploadFile, File()],
    consent: Annotated[bool, Form()] = True,
) -> SceneResponse:
    if not consent:
        raise HTTPException(status_code=422, detail="Explicit photo processing consent is required")
    content, mime, width, height = await read_validated_image(file, settings)
    processed = process_image(content, namespace="scenes", settings=settings)
    scene = Scene(
        organization_id=tenant.organization_id,
        user_id=tenant.user_id,
        original_path=str(processed.original_path),
        sanitized_path=str(processed.sanitized_path),
        thumbnail_path=str(processed.thumbnail_path),
        mime_type=mime,
        width_px=width,
        height_px=height,
        status="ready",
        consent_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=settings.room_retention_hours),
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return _scene_response(scene, settings)


@router.get("/{scene_id}", response_model=SceneResponse)
def get_scene(scene_id: str, db: Db, tenant: Tenant, settings: AppSettings) -> SceneResponse:
    return _scene_response(_get_scene(db, tenant.organization_id, scene_id), settings)


@router.post("/{scene_id}/analyse", response_model=SceneResponse)
def analyse_scene(scene_id: str, db: Db, tenant: Tenant, settings: AppSettings) -> SceneResponse:
    scene = _get_scene(db, tenant.organization_id, scene_id)
    # Local CPU fallback: explicit deterministic suggestions, always editable by the user.
    scene.analysis = {
        "mode": "mock",
        "depthModel": "manual-fallback",
        "vanishingPoints": [{"x": 0.5, "y": 0.36}],
        "lighting": {
            "direction": "left",
            "temperature": "neutral",
            "hardness": "soft",
            "confidence": 0.54,
        },
        "surfaces": [
            {
                "type": "table",
                "polygon": [
                    {"x": 0.18, "y": 0.62},
                    {"x": 0.82, "y": 0.62},
                    {"x": 0.9, "y": 0.84},
                    {"x": 0.1, "y": 0.84},
                ],
                "confidence": 0.62,
            },
            {
                "type": "wall",
                "polygon": [
                    {"x": 0.05, "y": 0.08},
                    {"x": 0.95, "y": 0.08},
                    {"x": 0.95, "y": 0.61},
                    {"x": 0.05, "y": 0.61},
                ],
                "confidence": 0.58,
            },
        ],
    }
    scene.status = "analysed"
    db.commit()
    db.refresh(scene)
    return _scene_response(scene, settings)


@router.post("/{scene_id}/surfaces", status_code=status.HTTP_201_CREATED)
def create_surface(
    scene_id: str,
    payload: SurfaceCreate,
    db: Db,
    tenant: Tenant,
) -> dict[str, object]:
    scene = _get_scene(db, tenant.organization_id, scene_id)
    surface = SceneSurface(
        organization_id=tenant.organization_id,
        scene_id=scene.id,
        surface_type=payload.surface_type,
        polygon=payload.polygon,
        confidence=1,
        source="manual",
    )
    db.add(surface)
    db.commit()
    db.refresh(surface)
    return {
        "id": surface.id,
        "sceneId": surface.scene_id,
        "surfaceType": surface.surface_type,
        "polygon": surface.polygon,
        "source": surface.source,
    }


@router.post("/{scene_id}/calibrate", status_code=status.HTTP_201_CREATED)
def calibrate_scene(
    scene_id: str,
    payload: CalibrationCreate,
    db: Db,
    tenant: Tenant,
) -> dict[str, object]:
    scene = _get_scene(db, tenant.organization_id, scene_id)
    pixels_per_cm: float | None = None
    homography: list[float] | None = None
    if payload.mode == "wall":
        start = _point(payload.parameters, "start")
        end = _point(payload.parameters, "end")
        real_length = float(payload.parameters.get("realLengthCm", 0))
        pixel_length = math.hypot(
            (end["x"] - start["x"]) * scene.width_px,
            (end["y"] - start["y"]) * scene.height_px,
        )
        if real_length <= 0 or pixel_length < 2:
            raise HTTPException(status_code=422, detail="Degenerate wall calibration")
        pixels_per_cm = pixel_length / real_length
    elif payload.mode == "surface":
        corners = payload.parameters.get("corners")
        width = float(payload.parameters.get("widthCm", 0))
        depth = float(payload.parameters.get("depthCm", 0))
        if not isinstance(corners, list) or len(corners) != 4 or width <= 0 or depth <= 0:
            raise HTTPException(
                status_code=422,
                detail="Four corners, width and depth are required",
            )
        target = [
            {"x": float(point["x"]) * scene.width_px, "y": float(point["y"]) * scene.height_px}
            for point in corners
        ]
        if _polygon_area(target) < 16:
            raise HTTPException(status_code=422, detail="Degenerate surface calibration")
        source = [
            {"x": 0.0, "y": 0.0},
            {"x": width, "y": 0.0},
            {"x": width, "y": depth},
            {"x": 0.0, "y": depth},
        ]
        homography = _homography(source, target)

    calibration = Calibration(
        organization_id=tenant.organization_id,
        scene_id=scene.id,
        surface_id=payload.surface_id,
        mode=payload.mode,
        parameters=payload.parameters,
        pixels_per_cm=pixels_per_cm,
        homography=homography,
        status="estimated" if payload.mode == "quick" else "calibrated",
    )
    db.add(calibration)
    db.commit()
    db.refresh(calibration)
    return {
        "id": calibration.id,
        "mode": calibration.mode,
        "status": calibration.status,
        "pixelsPerCm": calibration.pixels_per_cm,
        "homography": calibration.homography,
        "label": "Échelle estimée" if payload.mode == "quick" else "Échelle calibrée",
    }


def _get_scene(db: Session, organization_id: str, scene_id: str) -> Scene:
    scene = db.scalar(
        select(Scene).where(
            Scene.id == scene_id,
            Scene.organization_id == organization_id,
            Scene.deleted_at.is_(None),
        )
    )
    if scene is None:
        raise HTTPException(status_code=404, detail="Scene not found")
    return scene


def _scene_response(scene: Scene, settings: Settings) -> SceneResponse:
    return SceneResponse(
        id=scene.id,
        status=scene.status,
        image_url=public_storage_url(scene.sanitized_path, settings) or "",
        thumbnail_url=public_storage_url(scene.thumbnail_path, settings),
        width_px=scene.width_px,
        height_px=scene.height_px,
        analysis=scene.analysis,
        expires_at=scene.expires_at,
        created_at=scene.created_at,
    )


def _point(parameters: dict[str, Any], key: str) -> dict[str, float]:
    value = parameters.get(key)
    if not isinstance(value, dict) or "x" not in value or "y" not in value:
        raise HTTPException(status_code=422, detail=f"Missing calibration point: {key}")
    return {"x": float(value["x"]), "y": float(value["y"])}


def _polygon_area(points: list[dict[str, float]]) -> float:
    total = 0.0
    for index, point in enumerate(points):
        next_point = points[(index + 1) % len(points)]
        total += point["x"] * next_point["y"] - next_point["x"] * point["y"]
    return abs(total) / 2


def _homography(
    source: list[dict[str, float]], target: list[dict[str, float]]
) -> list[float]:
    matrix: list[list[float]] = []
    vector: list[float] = []
    for start, end in zip(source, target, strict=True):
        x, y, u, v = start["x"], start["y"], end["x"], end["y"]
        matrix.extend(
            [
                [x, y, 1, 0, 0, 0, -u * x, -u * y],
                [0, 0, 0, x, y, 1, -v * x, -v * y],
            ]
        )
        vector.extend([u, v])
    solution = _gaussian_solve(matrix, vector)
    return [*solution, 1.0]


def _gaussian_solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-10:
            raise HTTPException(status_code=422, detail="Singular calibration matrix")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                current - factor * pivot_value
                for current, pivot_value in zip(augmented[row], augmented[column], strict=True)
            ]
    return [row[-1] for row in augmented]
