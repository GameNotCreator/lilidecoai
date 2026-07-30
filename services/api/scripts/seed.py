import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.seed import seed_demo

if __name__ == "__main__":
    init_db()
    with SessionLocal() as database:
        seed_demo(database, get_settings())
    print("Demo data seeded.")
