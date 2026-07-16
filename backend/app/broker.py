"""HTTP client for the external trame session broker.

Two deletion entry points with explicit failure policies: ``delete_remote``
raises so callers can translate the failure (e.g. into a 502), while
``try_delete_remote`` logs and continues for cleanup paths where the local
state change already happened and must not be blocked by broker downtime.
"""

from __future__ import annotations

import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)


def broker_headers() -> dict[str, str]:
    return (
        {"Authorization": f"Bearer {settings.trame_broker_token}"}
        if settings.trame_broker_token
        else {}
    )


def delete_remote(remote_session_id: str) -> None:
    """Delete a broker session; raises httpx.HTTPError on broker failure."""
    if not settings.trame_broker_url:
        return
    response = httpx.delete(
        f"{settings.trame_broker_url.rstrip('/')}/sessions/{remote_session_id}",
        headers=broker_headers(),
        timeout=10,
    )
    if response.status_code >= 400 and response.status_code != 404:
        response.raise_for_status()


def try_delete_remote(remote_session_id: str) -> None:
    """Best-effort deletion for cleanup paths; failures are logged, not raised."""
    try:
        delete_remote(remote_session_id)
    except httpx.HTTPError:
        logger.exception("failed to delete remote session %s", remote_session_id)
