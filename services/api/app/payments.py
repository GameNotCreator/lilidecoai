from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import httpx

from .config import Settings

PACKS = {
    "starter": {"credits": 20, "amount_minor": 2900},
    "studio": {"credits": 75, "amount_minor": 7900},
    "scale": {"credits": 220, "amount_minor": 17900},
}


@dataclass(frozen=True)
class CheckoutResult:
    provider: str
    external_id: str
    status: str
    checkout_url: str


class PaymentProvider(Protocol):
    name: str

    def create_checkout(
        self,
        *,
        amount_minor: int,
        idempotency_key: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult: ...


class MockPaymentProvider:
    name = "mock"

    def create_checkout(
        self,
        *,
        amount_minor: int,
        idempotency_key: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        external_id = f"mock_{uuid4().hex}"
        return CheckoutResult(
            provider=self.name,
            external_id=external_id,
            status="completed",
            checkout_url=f"{success_url}?payment={external_id}&mock=1",
        )


class KonnectPaymentProvider:
    name = "konnect"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def create_checkout(
        self,
        *,
        amount_minor: int,
        idempotency_key: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        if not self.settings.konnect_api_key:
            raise RuntimeError("KONNECT_API_KEY is required outside demo mode")
        with httpx.Client(timeout=20) as client:
            response = client.post(
                f"{self.settings.konnect_base_url}/payments/init-payment",
                headers={
                    "x-api-key": self.settings.konnect_api_key,
                    "Idempotency-Key": idempotency_key,
                },
                json={
                    "receiverWalletId": "",
                    "token": "TND",
                    "amount": amount_minor,
                    "type": "immediate",
                    "acceptedPaymentMethods": ["wallet", "bank_card", "e-DINAR"],
                    "lifespan": 15,
                    "checkoutForm": True,
                    "addPaymentFeesToAmount": False,
                    "firstName": "Visualizer",
                    "lastName": "Customer",
                    "successUrl": success_url,
                    "failUrl": cancel_url,
                    "webhook": "",
                    "silentWebhook": True,
                },
            )
            response.raise_for_status()
            payload = response.json()
        return CheckoutResult(
            provider=self.name,
            external_id=str(payload["paymentRef"]),
            status="pending",
            checkout_url=str(payload["payUrl"]),
        )


def payment_provider(settings: Settings) -> PaymentProvider:
    if settings.demo_mode and not settings.is_production:
        return MockPaymentProvider()
    return KonnectPaymentProvider(settings)

