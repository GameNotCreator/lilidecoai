from dataclasses import dataclass
from typing import Annotated, Literal

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .database import get_db
from .models import Membership

Role = Literal["owner", "admin", "member", "viewer", "platform_admin"]


@dataclass(frozen=True)
class TenantContext:
    organization_id: str
    user_id: str
    role: Role


def get_tenant(
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    x_organization_id: Annotated[str | None, Header()] = None,
    x_user_id: Annotated[str | None, Header()] = None,
    x_user_role: Annotated[str | None, Header()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> TenantContext:
    if settings.demo_mode:
        valid_roles = {"owner", "admin", "member", "viewer", "platform_admin"}
        role = x_user_role if x_user_role in valid_roles else "owner"
        return TenantContext(
            organization_id=x_organization_id or settings.demo_organization_id,
            user_id=x_user_id or settings.demo_user_id,
            role=role,  # type: ignore[arg-type]
        )

    if not x_organization_id or not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required",
        )
    if not settings.supabase_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase JWT verification is not configured",
        )
    try:
        claims = jwt.decode(
            authorization.removeprefix("Bearer ").strip(),
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
        user_id = str(claims["sub"])
    except (jwt.PyJWTError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid access token",
        ) from exc
    membership = db.scalar(
        select(Membership).where(
            Membership.organization_id == x_organization_id,
            Membership.user_id == user_id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=403, detail="No access to this organization")
    return TenantContext(
        organization_id=x_organization_id,
        user_id=user_id,
        role=membership.role,  # type: ignore[arg-type]
    )


Tenant = Annotated[TenantContext, Depends(get_tenant)]


def require_roles(*roles: Role) -> object:
    def dependency(tenant: Tenant) -> TenantContext:
        if tenant.role not in roles:
            raise HTTPException(status_code=403, detail="Insufficient role")
        return tenant

    return Depends(dependency)
