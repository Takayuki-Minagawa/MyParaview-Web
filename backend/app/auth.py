"""OIDC authentication and project-scoped role checks.

Authentication is disabled by default for local development. In that mode the
``X-PVWeb-User`` header selects a development identity; production deployments
enable OIDC and only validated bearer-token subjects are trusted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import ProjectMember, User


@dataclass(frozen=True)
class Principal:
    id: str
    email: Optional[str] = None
    display_name: Optional[str] = None


def _decode_oidc_token(token: str) -> Principal:
    if not settings.oidc_issuer or not settings.oidc_audience or not settings.oidc_jwks_url:
        raise HTTPException(503, "OIDC requires issuer, audience, and JWKS URL configuration")
    try:
        signing_key = jwt.PyJWKClient(settings.oidc_jwks_url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.oidc_audience,
            issuer=settings.oidc_issuer,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "invalid bearer token") from exc
    subject = str(claims.get("sub") or "")
    if not subject:
        raise HTTPException(401, "bearer token has no subject")
    return Principal(
        id=subject,
        email=claims.get("email"),
        display_name=claims.get("name") or claims.get("preferred_username"),
    )


def get_principal(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_pvweb_user: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> Principal:
    oidc_values = (settings.oidc_issuer, settings.oidc_audience, settings.oidc_jwks_url)
    if any(oidc_values) and not all(oidc_values):
        raise HTTPException(503, "OIDC issuer, audience, and JWKS URL must be configured together")
    if all(oidc_values):
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "bearer token required")
        principal = _decode_oidc_token(token)
    else:
        principal = Principal(id=(x_pvweb_user or "anonymous").strip() or "anonymous")

    user = db.get(User, principal.id)
    if user is None:
        user = User(id=principal.id, email=principal.email, display_name=principal.display_name)
        db.add(user)
        db.commit()
    elif principal.email != user.email or principal.display_name != user.display_name:
        user.email = principal.email
        user.display_name = principal.display_name
        db.add(user)
        db.commit()
    request.state.principal = principal
    return principal


_ROLE_LEVEL = {"viewer": 1, "editor": 2, "admin": 3}


def require_project_role(
    db: Session,
    project_id: str,
    principal: Principal,
    minimum: str = "viewer",
) -> str:
    membership = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == principal.id,
        )
    )
    if membership is None or _ROLE_LEVEL.get(membership.role, 0) < _ROLE_LEVEL[minimum]:
        raise HTTPException(403, f"project {minimum} role required")
    return membership.role
