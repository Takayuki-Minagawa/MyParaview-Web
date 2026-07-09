"""OIDC authentication and project-scoped role checks.

Authentication is fail-closed by default. Local development must explicitly
select ``PVWEB_AUTH_MODE=dev`` before the ``X-PVWeb-User`` header is accepted;
OIDC mode only trusts validated bearer-token subjects.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import ProjectMember, User


@dataclass(frozen=True)
class Principal:
    id: str
    email: Optional[str] = None
    display_name: Optional[str] = None


@lru_cache(maxsize=4)
def _jwk_client(jwks_url: str):
    """Reuse PyJWT's signing-key cache across requests."""
    return jwt.PyJWKClient(jwks_url)


def _decode_oidc_token(token: str) -> Principal:
    if not settings.oidc_issuer or not settings.oidc_audience or not settings.oidc_jwks_url:
        raise HTTPException(503, "OIDC requires issuer, audience, and JWKS URL configuration")
    try:
        signing_key = _jwk_client(settings.oidc_jwks_url).get_signing_key_from_jwt(token)
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
    if settings.auth_mode not in {"oidc", "dev"}:
        raise HTTPException(503, "PVWEB_AUTH_MODE must be 'oidc' or 'dev'")
    if settings.auth_mode == "oidc":
        oidc_values = (settings.oidc_issuer, settings.oidc_audience, settings.oidc_jwks_url)
        if not all(oidc_values):
            raise HTTPException(
                503,
                "OIDC mode requires issuer, audience, and JWKS URL configuration",
            )
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
        try:
            db.commit()
        except IntegrityError:
            # Two first requests for a new OIDC subject may race. The winner's
            # insert is authoritative; the loser reloads instead of returning 500.
            db.rollback()
            user = db.get(User, principal.id)
            if user is None:
                raise
    else:
        changed = False
        if principal.email is not None and principal.email != user.email:
            user.email = principal.email
            changed = True
        if principal.display_name is not None and principal.display_name != user.display_name:
            user.display_name = principal.display_name
            changed = True
        if changed:
            db.add(user)
            db.commit()

    if settings.auth_mode == "oidc" and principal.id in settings.bootstrap_admin_subjects:
        # Only projects carrying the migration's anonymous-admin marker are
        # legacy recovery targets. Never turn a bootstrap subject into a
        # standing global admin for new OIDC-created projects.
        legacy_project_ids = set(
            db.scalars(
                select(ProjectMember.project_id).where(
                    ProjectMember.user_id == "anonymous",
                    ProjectMember.role == "admin",
                )
            )
        )
        for attempt in range(3):
            administered = set(
                db.scalars(
                    select(ProjectMember.project_id).where(
                        ProjectMember.user_id == principal.id,
                        ProjectMember.role == "admin",
                    )
                )
            )
            missing = legacy_project_ids - administered
            if not missing:
                break
            for project_id in missing:
                membership = db.scalar(
                    select(ProjectMember).where(
                        ProjectMember.project_id == project_id,
                        ProjectMember.user_id == principal.id,
                    )
                )
                if membership is None:
                    db.add(ProjectMember(project_id=project_id, user_id=principal.id, role="admin"))
                else:
                    membership.role = "admin"
                    db.add(membership)
            try:
                db.commit()
                break
            except IntegrityError:
                # Concurrent first requests can insert the same memberships.
                # Reload and retry the set difference rather than returning 500.
                db.rollback()
                if attempt == 2:
                    raise HTTPException(503, "bootstrap membership provisioning is busy")
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
