from uuid import uuid4

from fastapi.testclient import TestClient

from .helpers import image_bytes


def test_health_confirms_mock_mode(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "mode": "demo",
        "imageProvider": "mock",
        "openaiConfigured": False,
    }


def test_organization_isolation(client: TestClient, tenant_headers: dict[str, str]) -> None:
    created = client.post(
        "/v1/products",
        headers=tenant_headers,
        json={
            "name": "Sculpture privée",
            "widthCm": 20,
            "heightCm": 36,
            "depthCm": 18,
            "material": "grès",
            "placementType": "table",
        },
    )
    assert created.status_code == 201, created.text
    foreign_headers = {
        **tenant_headers,
        "X-Organization-Id": "00000000-0000-4000-8000-000000000099",
    }
    response = client.get(
        f"/v1/products/{created.json()['id']}",
        headers=foreign_headers,
    )
    assert response.status_code == 404


def test_full_vertical_slice_and_render_idempotency(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    product_response = client.post(
        "/v1/products",
        headers=tenant_headers,
        json={
            "name": "Vase test",
            "description": "Produit pour le parcours critique.",
            "sku": f"TEST-{uuid4().hex[:8]}",
            "widthCm": 24,
            "heightCm": 42,
            "depthCm": 24,
            "material": "céramique mate",
            "placementType": "table",
            "lightingProfile": {"reflectance": "matte"},
            "buyUrl": "https://example.com/test",
        },
    )
    assert product_response.status_code == 201, product_response.text
    product_id = product_response.json()["id"]
    upload = client.post(
        f"/v1/products/{product_id}/assets",
        headers=tenant_headers,
        files={"file": ("product.png", image_bytes(500, 700, product=True), "image/png")},
    )
    assert upload.status_code == 200, upload.text
    prepared = client.post(f"/v1/products/{product_id}/prepare", headers=tenant_headers)
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["status"] == "ready"
    assert prepared.json()["cutoutUrl"].endswith(".cutout.png")

    scene_response = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "true"},
    )
    assert scene_response.status_code == 201, scene_response.text
    scene_id = scene_response.json()["id"]
    analysis = client.post(f"/v1/scenes/{scene_id}/analyse", headers=tenant_headers)
    assert analysis.status_code == 200
    assert analysis.json()["analysis"]["mode"] == "mock"

    calibration_response = client.post(
        f"/v1/scenes/{scene_id}/calibrate",
        headers=tenant_headers,
        json={"mode": "quick", "parameters": {}},
    )
    assert calibration_response.status_code == 201
    calibration_id = calibration_response.json()["id"]
    credits_before = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    idempotency_key = f"test-render-{uuid4()}"
    payload = {
        "placement": {
            "sceneId": scene_id,
            "productId": product_id,
            "calibrationId": calibration_id,
            "mode": "quick",
            "xNormalized": 0.5,
            "yNormalized": 0.78,
            "scale": 0.24,
            "rotationDegrees": 0,
            "lighting": {
                "direction": "left",
                "temperature": "neutral",
                "hardness": "soft",
            },
        },
        "idempotencyKey": idempotency_key,
        "quality": "medium",
        "fidelityMode": "catalog",
    }
    rendered = client.post("/v1/renders", headers=tenant_headers, json=payload)
    assert rendered.status_code == 201, rendered.text
    result = rendered.json()
    assert result["status"] == "succeeded"
    assert result["provider"] == "mock"
    assert result["model"] == "deterministic-compositor-v1"
    assert result["creditCharged"] is True
    assert result["resultUrl"].endswith(".webp")
    assert float(result["qualityScore"]) >= 0.82
    assert result["attempts"][0]["usage"]["mode"] == "mock"

    duplicate = client.post("/v1/renders", headers=tenant_headers, json=payload)
    assert duplicate.status_code == 201
    assert duplicate.json()["id"] == result["id"]
    credits_after = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    assert credits_after == credits_before - 1


def test_failed_render_releases_reservation_without_debit(
    client: TestClient,
    tenant_headers: dict[str, str],
) -> None:
    product = client.post(
        "/v1/products",
        headers=tenant_headers,
        json={
            "name": "Produit sans image",
            "widthCm": 20,
            "heightCm": 30,
            "depthCm": 10,
            "material": "argile",
            "placementType": "table",
        },
    ).json()
    scene = client.post(
        "/v1/scenes",
        headers=tenant_headers,
        files={"file": ("room.png", image_bytes(), "image/png")},
        data={"consent": "true"},
    ).json()
    before = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    response = client.post(
        "/v1/renders",
        headers=tenant_headers,
        json={
            "placement": {
                "sceneId": scene["id"],
                "productId": product["id"],
                "mode": "quick",
                "xNormalized": 0.5,
                "yNormalized": 0.7,
                "scale": 0.2,
            },
            "idempotencyKey": f"failed-{uuid4()}",
            "quality": "medium",
            "fidelityMode": "catalog",
        },
    )
    assert response.status_code == 201
    assert response.json()["status"] == "failed"
    assert response.json()["creditCharged"] is False
    after = client.get("/v1/credits", headers=tenant_headers).json()["balance"]
    assert after == before
    assert any(
        transaction["type"] == "render_release"
        for transaction in client.get("/v1/credits", headers=tenant_headers).json()["transactions"]
    )

