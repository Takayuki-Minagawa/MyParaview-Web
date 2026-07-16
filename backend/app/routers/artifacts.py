from __future__ import annotations

import os
import struct
import zlib
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..access import authorized_dataset, authorized_job
from ..auth import Principal, get_principal, require_project_role
from ..config import settings
from ..db import get_db
from ..models import Artifact, Dataset, Job
from ..project_locks import locked_project
from ..responses import LeasedFileResponse
from ..schemas import ArtifactOut, DatasetOut
from ..storage import store
from .datasets import _sniff_ok

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


def _valid_png(path: Path) -> bool:
    """Validate PNG structure and per-chunk CRCs by streaming, not read_bytes()."""
    total = path.stat().st_size
    with open(path, "rb") as source:
        if source.read(8) != b"\x89PNG\r\n\x1a\n":
            return False
        offset = 8
        saw_header = False
        while offset + 12 <= total:
            header = source.read(8)
            if len(header) != 8:
                return False
            length = struct.unpack(">I", header[:4])[0]
            chunk_type = header[4:8]
            end = offset + 12 + length
            if end > total:
                return False
            crc = zlib.crc32(chunk_type)
            remaining = length
            first_payload = b""
            while remaining > 0:
                chunk = source.read(min(remaining, 1024 * 1024))
                if not chunk:
                    return False
                if not first_payload:
                    first_payload = chunk
                crc = zlib.crc32(chunk, crc)
                remaining -= len(chunk)
            crc_bytes = source.read(4)
            if len(crc_bytes) != 4:
                return False
            if crc & 0xFFFFFFFF != struct.unpack(">I", crc_bytes)[0]:
                return False
            if not saw_header:
                if chunk_type != b"IHDR" or length != 13 or len(first_payload) < 8:
                    return False
                width, height = struct.unpack(">II", first_payload[:8])
                if width == 0 or height == 0:
                    return False
                saw_header = True
            if chunk_type == b"IEND":
                return saw_header and length == 0 and end == total
            offset = end
    return False


@router.get("", response_model=list[ArtifactOut])
def list_artifacts(
    dataset_id: Optional[str] = None,
    job_id: Optional[str] = None,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if not dataset_id and not job_id:
        raise HTTPException(422, "dataset_id or job_id is required")
    stmt = select(Artifact).order_by(Artifact.created_at.desc())
    if dataset_id:
        authorized_dataset(db, dataset_id, principal)
        stmt = stmt.where(Artifact.dataset_id == dataset_id)
    if job_id:
        authorized_job(db, job_id, principal)
        stmt = stmt.where(Artifact.job_id == job_id)
    return list(db.scalars(stmt))


@router.post("", response_model=ArtifactOut, status_code=201)
async def upload_artifact(
    dataset_id: str,
    kind: str,
    file: UploadFile,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if kind not in {"screenshot", "client_export"}:
        raise HTTPException(422, "client artifact kind must be screenshot or client_export")
    dataset = authorized_dataset(db, dataset_id, principal, "editor")
    filename = os.path.basename(file.filename or f"{kind}.bin")
    suffix = os.path.splitext(filename)[1].lower()
    head = await file.read(8)
    if kind == "screenshot" and head != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(400, "screenshot artifact must be a PNG")
    await file.seek(0)
    object_key = store.new_key(suffix)
    try:
        # Blocking store/validation work stays off the event loop.
        size = await run_in_threadpool(
            store.save_stream,
            object_key,
            file.file,
            max_bytes=min(settings.max_upload_bytes, settings.max_artifact_bytes),
        )
        if kind == "screenshot":
            def _validate() -> bool:
                with store.local_path(object_key) as local_object:
                    return _valid_png(local_object)

            if not await run_in_threadpool(_validate):
                raise HTTPException(400, "screenshot artifact is not a valid PNG")
        project_id = dataset.project_id
        with locked_project(db, project_id, principal, "editor"):
            dataset = db.get(Dataset, dataset_id)
            if dataset is None or dataset.project_id != project_id:
                raise HTTPException(409, "dataset project was deleted during artifact upload")
            artifact = Artifact(
                dataset_id=dataset.id,
                kind=kind,
                filename=filename,
                size_bytes=size,
                object_key=object_key,
                content_type=file.content_type or "application/octet-stream",
            )
            db.add(artifact)
            db.flush()
        request.state.audit_project_id = dataset.project_id
        request.state.audit_resource_type = "artifact"
        request.state.audit_resource_id = artifact.id
        return artifact
    except ValueError as exc:
        store.delete(object_key)
        raise HTTPException(413, str(exc)) from exc
    except Exception:
        store.delete(object_key)
        raise


@router.post("/{artifact_id}/promote", response_model=DatasetOut, status_code=201)
def promote_artifact(
    artifact_id: str,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Register a derived artifact (e.g. converted VTP) as a first-class dataset.

    The object is copied to a fresh key so dataset and artifact lifecycles stay
    independent; the caller then runs the normal ingest job on the new dataset.
    """
    artifact = db.get(Artifact, artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    if not artifact.dataset_id:
        raise HTTPException(422, "artifact is not attached to a dataset")
    source_dataset = db.get(Dataset, artifact.dataset_id)
    if source_dataset is None:
        raise HTTPException(410, "artifact dataset no longer exists")
    project_id = source_dataset.project_id
    ext = os.path.splitext(artifact.filename)[1].lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(422, f"artifact type {ext!r} cannot be promoted to a dataset")
    if ext in {".case", ".xdmf", ".xmf"}:
        raise HTTPException(
            422, "descriptor artifacts cannot be promoted without their referenced files"
        )
    require_project_role(db, project_id, principal, "editor")

    new_key = store.new_key(ext)
    try:
        with store.local_path(artifact.object_key) as source_path:
            if not source_path.is_file():
                raise HTTPException(410, "artifact object no longer available")
            # Promotion creates a first-class dataset, so the artifact bytes
            # must pass the same magic/header guard as a direct upload.
            with open(source_path, "rb") as source_head:
                head = source_head.read(4096)
            if not _sniff_ok(ext, head):
                raise HTTPException(400, f"artifact content does not match a {ext} file")
            size = store.copy_in(new_key, source_path)
        with locked_project(db, project_id, principal, "editor"):
            current = db.get(Artifact, artifact_id)
            if current is None:
                raise HTTPException(409, "artifact was deleted during promotion")
            dataset = Dataset(
                project_id=project_id,
                filename=artifact.filename,
                ext=ext,
                size_bytes=size,
                object_key=new_key,
                status="registered",
            )
            db.add(dataset)
            db.flush()
    except Exception:
        store.delete(new_key)
        raise
    request.state.audit_project_id = project_id
    request.state.audit_resource_type = "dataset"
    request.state.audit_resource_id = dataset.id
    return dataset


@router.get("/{artifact_id}")
def get_artifact(
    artifact_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    art = db.get(Artifact, artifact_id)
    if art is None:
        raise HTTPException(404, "artifact not found")
    project_id: Optional[str] = None
    if art.dataset_id:
        dataset = db.get(Dataset, art.dataset_id)
        if dataset is None:
            raise HTTPException(410, "artifact dataset no longer exists")
        project_id = dataset.project_id
    elif art.job_id:
        job = db.get(Job, art.job_id)
        if job is None or not job.project_id:
            raise HTTPException(410, "artifact has no accessible project scope")
        project_id = job.project_id
    if not project_id:
        raise HTTPException(410, "artifact has no accessible project scope")
    require_project_role(db, project_id, principal)
    presigned = store.presigned_url(art.object_key, filename=art.filename)
    # Presigning does not verify the object exists; fall through to the
    # streaming path (and its 410) when the object is gone.
    if presigned and store.exists(art.object_key):
        return RedirectResponse(presigned, status_code=307)
    path = store.acquire_path(art.object_key)
    if not path.is_file():
        store.release_path(art.object_key)
        raise HTTPException(410, "artifact object no longer available")
    return LeasedFileResponse(
        str(path),
        store=store,
        object_key=art.object_key,
        media_type=art.content_type,
        filename=art.filename,
    )
