import hashlib
import hmac
from uuid import uuid4

from fastapi.testclient import TestClient

from .helpers import image_bytes


def test_checkout_is_idempotent_and_credits_once(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    before = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    key = f"checkout-test-{uuid4()}"
    payload = {"pack": "starter", "idempotencyKey": key}
    first = client.post("/v1/checkout", headers=tenant_headers, json=payload)
    second = client.post("/v1/checkout", headers=tenant_headers, json=payload)
    assert first.status_code == 200
    assert first.json()["provider"] == "mock"
    assert first.json()["credited"] is True
    assert second.json()["id"] == first.json()["id"]
    after = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    assert after == before + 20


def test_webhook_rejects_invalid_signature(client: TestClient) -> None:
    response = client.post(
        "/v1/webhooks/konnect",
        content=b'{"paymentRef":"unknown","status":"paid"}',
        headers={"X-Konnect-Signature": "invalid"},
    )
    assert response.status_code == 401


def test_webhook_accepts_signature_before_payment_lookup(client: TestClient) -> None:
    body = b'{"paymentRef":"unknown","status":"paid"}'
    signature = hmac.new(b"test-webhook-secret", body, hashlib.sha256).hexdigest()
    response = client.post(
        "/v1/webhooks/konnect",
        content=body,
        headers={"X-Konnect-Signature": signature},
    )
    assert response.status_code == 404


def test_upload_rejects_spoofed_or_small_images(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    small = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(100, 100), "image/png")},
        data={"consent": "true"},
    )
    assert small.status_code == 422
    spoofed = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", b"not an image", "image/png")},
        data={"consent": "true"},
    )
    assert spoofed.status_code == 415


def test_scene_requires_explicit_consent(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    response = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "false"},
    )
    assert response.status_code == 422

