import json
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Tenant
from ..config import Settings, get_settings
from ..credits import add_credits, get_or_create_wallet
from ..database import get_db
from ..models import CreditTransaction, Payment, Subscription
from ..payments import PACKS, payment_provider
from ..schemas import CheckoutCreate
from ..security import verify_hmac_signature

router = APIRouter(tags=["billing"])
Db = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@router.get("/credits")
def credits(db: Db, tenant: Tenant) -> dict[str, object]:
    wallet = get_or_create_wallet(db, tenant.organization_id)
    transactions = db.scalars(
        select(CreditTransaction)
        .where(CreditTransaction.organization_id == tenant.organization_id)
        .order_by(CreditTransaction.created_at.desc())
        .limit(20)
    ).all()
    db.commit()
    return {
        "balance": wallet.balance,
        "transactions": [
            {
                "id": transaction.id,
                "type": transaction.transaction_type,
                "amount": transaction.amount,
                "status": transaction.status,
                "balanceAfter": transaction.balance_after,
                "createdAt": transaction.created_at,
            }
            for transaction in transactions
        ],
    }


@router.post("/checkout")
def checkout(
    payload: CheckoutCreate,
    db: Db,
    tenant: Tenant,
    settings: AppSettings,
) -> dict[str, object]:
    existing = db.scalar(
        select(Payment).where(
            Payment.organization_id == tenant.organization_id,
            Payment.idempotency_key == payload.idempotency_key,
        )
    )
    if existing:
        return _payment_response(existing)
    pack = PACKS[payload.pack]
    success_url = str(payload.success_url or f"{settings.web_url}/app/billing?status=success")
    cancel_url = str(payload.cancel_url or f"{settings.web_url}/app/billing?status=cancelled")
    provider = payment_provider(settings)
    try:
        result = provider.create_checkout(
            amount_minor=pack["amount_minor"],
            idempotency_key=payload.idempotency_key,
            success_url=success_url,
            cancel_url=cancel_url,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Payment provider unavailable: {exc}") from exc
    payment = Payment(
        organization_id=tenant.organization_id,
        provider=result.provider,
        external_id=result.external_id,
        idempotency_key=payload.idempotency_key,
        status=result.status,
        amount_minor=pack["amount_minor"],
        currency="TND",
        credits=pack["credits"],
        checkout_url=result.checkout_url,
    )
    db.add(payment)
    db.flush()
    if result.provider == "mock" and result.status == "completed":
        add_credits(
            db,
            tenant.organization_id,
            pack["credits"],
            f"payment:{result.external_id}:credits",
            {"paymentId": payment.id, "mock": True},
        )
        payment.credited_at = datetime.now(UTC)
    db.commit()
    db.refresh(payment)
    return _payment_response(payment)


@router.get("/subscription")
def subscription(db: Db, tenant: Tenant) -> dict[str, object]:
    value = db.scalar(
        select(Subscription)
        .where(
            Subscription.organization_id == tenant.organization_id,
            Subscription.deleted_at.is_(None),
        )
        .order_by(Subscription.created_at.desc())
    )
    if value is None:
        return {"plan": "free", "status": "inactive", "renewsAt": None}
    return {"plan": value.plan, "status": value.status, "renewsAt": value.renews_at}


@router.post("/webhooks/konnect")
async def konnect_webhook(
    request: Request,
    db: Db,
    settings: AppSettings,
    x_konnect_signature: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    if not settings.konnect_webhook_secret:
        raise HTTPException(status_code=503, detail="Konnect webhook secret is not configured")
    body = await request.body()
    if not verify_hmac_signature(body, x_konnect_signature, settings.konnect_webhook_secret):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
    try:
        payload = json.loads(body)
        external_id = str(payload["paymentRef"])
        succeeded = str(payload.get("status", "")).lower() in {"completed", "success", "paid"}
    except (json.JSONDecodeError, KeyError) as exc:
        raise HTTPException(status_code=422, detail="Invalid webhook payload") from exc
    payment = db.scalar(
        select(Payment).where(Payment.provider == "konnect", Payment.external_id == external_id)
    )
    if payment is None:
        raise HTTPException(status_code=404, detail="Payment not found")
    payment.raw_payload = payload
    if succeeded and payment.credited_at is None:
        payment.status = "completed"
        add_credits(
            db,
            payment.organization_id,
            payment.credits,
            f"payment:{payment.external_id}:credits",
            {"paymentId": payment.id, "provider": "konnect"},
        )
        payment.credited_at = datetime.now(UTC)
    db.commit()
    return {"received": True}


def _payment_response(payment: Payment) -> dict[str, object]:
    return {
        "id": payment.id,
        "provider": payment.provider,
        "status": payment.status,
        "credits": payment.credits,
        "amountMinor": payment.amount_minor,
        "currency": payment.currency,
        "checkoutUrl": payment.checkout_url,
        "credited": payment.credited_at is not None,
    }

