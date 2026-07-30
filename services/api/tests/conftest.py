import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TEST_ROOT = Path(tempfile.gettempdir()) / f"project-visualizer-tests-{os.getpid()}"
shutil.rmtree(TEST_ROOT, ignore_errors=True)
TEST_ROOT.mkdir(parents=True, exist_ok=True)

os.environ["DATABASE_URL"] = f"sqlite:///{(TEST_ROOT / 'test.db').as_posix()}"
os.environ["STORAGE_PATH"] = str(TEST_ROOT / "storage")
os.environ["DEMO_MODE"] = "true"
os.environ["OPENAI_API_KEY"] = ""
os.environ["KONNECT_WEBHOOK_SECRET"] = "test-webhook-secret"
os.environ["SIGNED_URL_SECRET"] = "test-signed-url-secret"

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as value:
        yield value


@pytest.fixture(scope="session")
def tenant_headers() -> dict[str, str]:
    return {
        "X-Organization-Id": "00000000-0000-4000-8000-000000000001",
        "X-User-Id": "00000000-0000-4000-8000-000000000002",
    }

