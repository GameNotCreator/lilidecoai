from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import CreditTransaction, CreditWallet


class InsufficientCreditsError(RuntimeError):
    pass


def get_or_create_wallet(
    db: Session,
    organization_id: str,
    initial_balance: int = 0,
) -> CreditWallet:
    wallet = db.scalar(
        select(CreditWallet).where(CreditWallet.organization_id == organization_id)
    )
    if wallet is None:
        wallet = CreditWallet(organization_id=organization_id, balance=initial_balance)
        db.add(wallet)
        db.flush()
    return wallet


def reserve_credit(db: Session, organization_id: str, render_id: str) -> CreditTransaction:
    wallet = get_or_create_wallet(db, organization_id)
    if wallet.balance < 1:
        raise InsufficientCreditsError("At least one credit is required")
    key = f"render:{render_id}:reservation"
    existing = db.scalar(
        select(CreditTransaction).where(
            CreditTransaction.organization_id == organization_id,
            CreditTransaction.idempotency_key == key,
        )
    )
    if existing:
        return existing
    reservation = CreditTransaction(
        organization_id=organization_id,
        wallet_id=wallet.id,
        render_id=render_id,
        amount=0,
        transaction_type="render_reservation",
        status="reserved",
        idempotency_key=key,
        balance_after=wallet.balance,
    )
    db.add(reservation)
    db.flush()
    return reservation


def capture_credit(db: Session, organization_id: str, render_id: str) -> CreditTransaction:
    key = f"render:{render_id}:capture"
    existing = db.scalar(
        select(CreditTransaction).where(
            CreditTransaction.organization_id == organization_id,
            CreditTransaction.idempotency_key == key,
        )
    )
    if existing:
        return existing
    wallet = db.scalar(
        select(CreditWallet)
        .where(CreditWallet.organization_id == organization_id)
        .with_for_update()
    )
    if wallet is None or wallet.balance < 1:
        raise InsufficientCreditsError("Credit balance changed before capture")
    wallet.balance -= 1
    transaction = CreditTransaction(
        organization_id=organization_id,
        wallet_id=wallet.id,
        render_id=render_id,
        amount=-1,
        transaction_type="render_capture",
        status="confirmed",
        idempotency_key=key,
        balance_after=wallet.balance,
    )
    db.add(transaction)
    db.flush()
    return transaction


def release_credit(db: Session, organization_id: str, render_id: str) -> CreditTransaction:
    key = f"render:{render_id}:release"
    existing = db.scalar(
        select(CreditTransaction).where(
            CreditTransaction.organization_id == organization_id,
            CreditTransaction.idempotency_key == key,
        )
    )
    if existing:
        return existing
    wallet = get_or_create_wallet(db, organization_id)
    transaction = CreditTransaction(
        organization_id=organization_id,
        wallet_id=wallet.id,
        render_id=render_id,
        amount=0,
        transaction_type="render_release",
        status="refunded",
        idempotency_key=key,
        balance_after=wallet.balance,
    )
    db.add(transaction)
    db.flush()
    return transaction


def add_credits(
    db: Session,
    organization_id: str,
    amount: int,
    idempotency_key: str,
    metadata: dict[str, object] | None = None,
) -> CreditTransaction:
    existing = db.scalar(
        select(CreditTransaction).where(
            CreditTransaction.organization_id == organization_id,
            CreditTransaction.idempotency_key == idempotency_key,
        )
    )
    if existing:
        return existing
    wallet = get_or_create_wallet(db, organization_id)
    wallet.balance += amount
    transaction = CreditTransaction(
        organization_id=organization_id,
        wallet_id=wallet.id,
        amount=amount,
        transaction_type="purchase",
        status="confirmed",
        idempotency_key=idempotency_key,
        balance_after=wallet.balance,
        metadata_json=metadata or {},
    )
    db.add(transaction)
    db.flush()
    return transaction

