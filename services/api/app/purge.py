from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import Scene
from .security import safe_unlink


def purge_expired_scenes(db: Session, settings: Settings) -> int:
    expired = db.scalars(
        select(Scene).where(
            Scene.expires_at <= datetime.now(UTC),
            Scene.deleted_at.is_(None),
        )
    ).all()
    for scene in expired:
        for path in (scene.original_path, scene.sanitized_path, scene.thumbnail_path):
            if path:
                safe_unlink(path, settings.storage_path)
        scene.deleted_at = datetime.now(UTC)
        scene.status = "purged"
    db.commit()
    return len(expired)

