from __future__ import annotations

import os
import struct
import zlib
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..config import settings
from ..db import get_db
from ..models import Artifact, Dataset, Job
from ..schemas import ArtifactOut
from ..storage import store

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


def _valid_png(path: Path) -> bool:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    offset = 8
    saw_header = False
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if end > len(data):
            return False
        payload = data[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack(">I", data[offset + 8 + length : end])[0]
        if zlib.crc32(chunk_type + payload) & 0xFFFFFFFF != expected_crc:
            return False
        if not saw_header:
            if chunk_type != b"IHDR" or length != 13:
                return False
            width, height = struct.unpack(">II", payload[:8])
            if width == 0 or height == 0:
                return False
            saw_header = True
        if chunk_type == b"IEND":
            return saw_header and length == 0 and end == len(data)
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
        dataset = db.get(Dataset, dataset_id)
        if dataset is None:
            raise HTTPException(404, "dataset not found")
        require_project_role(db, dataset.project_id, principal)
        stmt = stmt.where(Artifact.dataset_id == dataset_id)
    if job_id:
        job = db.get(Job, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        if not job.project_id:
            raise HTTPException(403, "unscoped job access is forbidden")
        require_project_role(db, job.project_id, principal)
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
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal, "editor")
    filename = os.path.basename(file.filename or f"{kind}.bin")
    suffix = os.path.splitext(filename)[1].lower()
    head = await file.read(8)
    if kind == "screenshot" and head != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(400, "screenshot artifact must be a PNG")
    await file.seek(0)
    object_key = store.new_key(suffix)
    try:
        size = store.save_stream(
            object_key,
            file.file,
            max_bytes=min(settings.max_upload_bytes, 32 * 1024 * 1024),
        )
        if kind == "screenshot" and not _valid_png(store.path_for(object_key)):
            raise HTTPException(400, "screenshot artifact is not a valid PNG")
        artifact = Artifact(
            dataset_id=dataset.id,
            kind=kind,
            filename=filename,
            size_bytes=size,
            object_key=object_key,
            content_type=file.content_type or "application/octet-stream",
        )
        db.add(artifact)
        db.commit()
        db.refresh(artifact)
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
    path = store.path_for(art.object_key)
    if not path.is_file():
        raise HTTPException(410, "artifact object no longer available")
    return FileResponse(str(path), media_type=art.content_type, filename=art.filename)
