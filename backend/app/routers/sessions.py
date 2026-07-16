from __future__ import annotations

import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..access import require_project, tag_audit
from ..auth import Principal, get_principal, require_project_role
from ..config import settings
from ..db import SessionLocal, get_db
from ..models import Dataset, RenderSession
from ..project_locks import locked_project
from ..schemas import RenderSessionCreate, RenderSessionCreated, RenderSessionOut

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _broker_headers() -> dict[str, str]:
    return (
        {"Authorization": f"Bearer {settings.trame_broker_token}"}
        if settings.trame_broker_token
        else {}
    )


def _delete_remote_id(remote_session_id: str) -> None:
    if not settings.trame_broker_url:
        return
    response = httpx.delete(
        f"{settings.trame_broker_url.rstrip('/')}/sessions/{remote_session_id}",
        headers=_broker_headers(),
        timeout=10,
    )
    if response.status_code >= 400 and response.status_code != 404:
        response.raise_for_status()


def _delete_remote_session(render_session: RenderSession) -> None:
    _delete_remote_id(render_session.remote_session_id)


def _best_effort_delete_remote(remote_session_id: str) -> None:
    try:
        _delete_remote_id(remote_session_id)
    except httpx.HTTPError:
        pass


def _is_expired(render_session: RenderSession) -> bool:
    expires_at = render_session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)


def _mark_session_expired(session_id: str) -> RenderSession | None:
    with SessionLocal() as db:
        render_session = db.get(RenderSession, session_id)
        if render_session is None:
            return None
        project_id = render_session.project_id
        try:
            with locked_project(db, project_id):
                render_session = db.get(RenderSession, session_id)
                if render_session is None:
                    return None
                render_session.status = "expired"
                db.add(render_session)
                db.flush()
                return render_session
        except HTTPException as exc:
            if exc.status_code == 404:
                return None
            raise


def _validated_remote_target(remote_ws_url: str):
    parsed_remote = urlparse(remote_ws_url)
    broker_host = urlparse(settings.trame_broker_url or "").hostname
    allowed_hosts = settings.trame_allowed_ws_hosts or ({broker_host.lower()} if broker_host else set())
    if (
        parsed_remote.scheme not in {"ws", "wss"}
        or not parsed_remote.hostname
        or parsed_remote.hostname.lower() not in allowed_hosts
        or parsed_remote.username is not None
        or parsed_remote.password is not None
    ):
        return None
    return parsed_remote


@router.post("", response_model=RenderSessionCreated, status_code=201)
def create_session(
    payload: RenderSessionCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    require_project(db, payload.project_id, principal, "editor")
    dataset = db.get(Dataset, payload.dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    if dataset.project_id != payload.project_id:
        raise HTTPException(422, "dataset belongs to a different project")
    if not settings.trame_broker_url:
        raise HTTPException(503, "trame session broker capability is not configured")

    try:
        response = httpx.post(
            f"{settings.trame_broker_url.rstrip('/')}/sessions",
            headers=_broker_headers(),
            json={
                "dataset_id": dataset.id,
                "object_key": dataset.object_key,
                "filename": dataset.filename,
                "mode": payload.mode,
                "ttl_seconds": settings.session_ttl_seconds,
            },
            timeout=15,
        )
        response.raise_for_status()
        broker = response.json()
        remote_id = str(broker["id"])
        remote_ws_url = str(broker["websocket_url"])
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(502, "trame session broker failed to create a session") from exc
    if _validated_remote_target(remote_ws_url) is None:
        _best_effort_delete_remote(remote_id)
        raise HTTPException(502, "trame broker returned an invalid WebSocket URL")

    access_token = secrets.token_urlsafe(32)
    try:
        with locked_project(db, payload.project_id, principal, "editor"):
            dataset = db.get(Dataset, payload.dataset_id)
            if dataset is None or dataset.project_id != payload.project_id:
                raise HTTPException(409, "dataset project was deleted during session creation")
            render_session = RenderSession(
                project_id=payload.project_id,
                dataset_id=payload.dataset_id,
                mode=payload.mode,
                status="active",
                remote_session_id=remote_id,
                remote_ws_url=remote_ws_url,
                access_token_hash=hashlib.sha256(access_token.encode()).hexdigest(),
                expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.session_ttl_seconds),
            )
            db.add(render_session)
            db.flush()
    except Exception:
        db.rollback()
        _best_effort_delete_remote(remote_id)
        raise
    tag_audit(request, "session", render_session.id, payload.project_id)
    return {
        **RenderSessionOut.model_validate(render_session).model_dump(),
        "websocket_path": f"/sessions/{render_session.id}/ws",
        "websocket_protocol": f"pvweb.{access_token}",
    }


@router.get("/{session_id}", response_model=RenderSessionOut)
def get_session(
    session_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    render_session = db.get(RenderSession, session_id)
    if render_session is None:
        raise HTTPException(404, "render session not found")
    require_project_role(db, render_session.project_id, principal)
    if render_session.status == "active" and _is_expired(render_session):
        project_id = render_session.project_id
        with locked_project(db, project_id, principal):
            render_session = db.get(RenderSession, session_id)
            if render_session is None:
                raise HTTPException(404, "render session not found")
            render_session.status = "expired"
            db.add(render_session)
            db.flush()
        try:
            _delete_remote_session(render_session)
        except httpx.HTTPError:
            pass
    return render_session


@router.delete("/{session_id}", status_code=204)
def delete_session(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    render_session = db.get(RenderSession, session_id)
    if render_session is None:
        raise HTTPException(404, "render session not found")
    require_project_role(db, render_session.project_id, principal, "editor")
    tag_audit(request, "session", render_session.id, render_session.project_id)
    try:
        _delete_remote_session(render_session)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "trame broker failed to delete the remote session") from exc
    project_id = render_session.project_id
    with locked_project(db, project_id, principal, "editor"):
        render_session = db.get(RenderSession, session_id)
        if render_session is None:
            return
        db.delete(render_session)


@router.websocket("/{session_id}/ws")
async def proxy_session_websocket(
    websocket: WebSocket,
    session_id: str,
):
    offered_protocols = [
        value.strip()
        for value in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if value.strip()
    ]
    selected_protocol = next(
        (protocol for protocol in offered_protocols if protocol.startswith("pvweb.")),
        "",
    )
    token = selected_protocol.removeprefix("pvweb.")
    with SessionLocal() as db:
        render_session = db.get(RenderSession, session_id)
        if render_session is None:
            await websocket.close(code=4404)
            return
        expected = render_session.access_token_hash
        expires_at = render_session.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if (
            not secrets.compare_digest(hashlib.sha256(token.encode()).hexdigest(), expected)
            or expires_at <= datetime.now(timezone.utc)
        ):
            await websocket.close(code=4401)
            return
        remote_ws_url = render_session.remote_ws_url
        remote_target = _validated_remote_target(remote_ws_url)
        if remote_target is None:
            await websocket.close(code=4403)
            return
        remote_host = remote_target.hostname
        remote_port = remote_target.port or (443 if remote_target.scheme == "wss" else 80)
        remaining_seconds = max(
            0.0,
            (expires_at - datetime.now(timezone.utc)).total_seconds(),
        )

    await websocket.accept(subprotocol=selected_protocol)
    try:
        # Pin the network target to the host/port already checked at session
        # creation. websockets rejects cross-origin redirects when explicit
        # host/port are supplied, preventing a trusted endpoint from redirecting
        # the proxy into an internal SSRF target.
        async with websockets.connect(
            remote_ws_url,
            host=remote_host,
            port=remote_port,
            proxy=None,
            max_size=None,
        ) as remote:
            async def to_remote() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        return
                    if message.get("bytes") is not None:
                        await remote.send(message["bytes"])
                    elif message.get("text") is not None:
                        await remote.send(message["text"])

            async def to_client() -> None:
                async for message in remote:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            expiry_task = asyncio.create_task(asyncio.sleep(remaining_seconds))
            tasks = [asyncio.create_task(to_remote()), asyncio.create_task(to_client()), expiry_task]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
            if expiry_task in done:
                expired_session = await asyncio.to_thread(_mark_session_expired, session_id)
                if expired_session is not None:
                    try:
                        await asyncio.to_thread(_delete_remote_session, expired_session)
                    except httpx.HTTPError:
                        pass
                await websocket.close(code=4401, reason="render session expired")
    except (WebSocketDisconnect, OSError, websockets.WebSocketException):
        await websocket.close(code=1011)
