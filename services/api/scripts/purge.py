import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.purge import purge_expired_scenes

if __name__ == "__main__":
    init_db()
    with SessionLocal() as database:
        count = purge_expired_scenes(database, get_settings())
    print(f"Purged {count} expired scenes.")
