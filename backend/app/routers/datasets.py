from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..jobs import manager
from ..models import Dataset, Job, Project
from ..schemas import DatasetOut, JobOut
from ..services import run_ingest
from ..storage import store

router = APIRouter(tags=["datasets"])


def _sniff_ok(ext: str, head: bytes) -> bool:
    """Lightweight magic/header check (work_plan 8.3): don't trust the extension."""
    if ext in {".vtp", ".vti", ".vtu", ".vts", ".vtr", ".pvd"}:
        prefix = head.lstrip()[:200].lower()
        return prefix.startswith(b"<?xml") or b"<vtkfile" in prefix or b"<collection" in prefix
    if ext == ".csv":
        # A UTF-8 multibyte char can straddle the 4 KB read boundary, so a strict
        # decode would false-reject valid (e.g. Japanese) CSVs. Treat as text
        # unless it contains a NUL byte (a reliable binary marker).
        return b"\x00" not in head
    return False


@router.post("/projects/{project_id}/datasets", response_model=DatasetOut, status_code=201)
async def upload_dataset(
    project_id: str, file: UploadFile, db: Session = Depends(get_db)
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")

    filename = os.path.basename(file.filename or "upload")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(415, f"unsupported extension {ext!r}")

    head = await file.read(4096)
    if not _sniff_ok(ext, head):
        raise HTTPException(400, f"file content does not match a {ext} file")
    await file.seek(0)

    key = store.new_key(ext)
    try:
        size = store.save_stream(key, file.file, max_bytes=settings.max_upload_bytes)
    except ValueError as exc:
        raise HTTPException(413, str(exc)) from exc

    ds = Dataset(
        project_id=project_id, filename=filename, ext=ext,
        size_bytes=size, object_key=key, status="registered",
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return ds


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetOut])
def list_datasets(project_id: str, db: Session = Depends(get_db)):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    stmt = select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.created_at.desc())
    return list(db.scalars(stmt))


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: str, db: Session = Depends(get_db)):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    return ds


@router.get("/datasets/{dataset_id}/metadata", response_model=DatasetOut)
def get_metadata(dataset_id: str, db: Session = Depends(get_db)):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    return ds


@router.post("/datasets/{dataset_id}/ingest", response_model=JobOut, status_code=202)
def ingest_dataset(dataset_id: str, db: Session = Depends(get_db)):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    job = Job(project_id=ds.project_id, kind="ingest", status="queued", target_id=dataset_id)
    db.add(job)
    db.commit()
    db.refresh(job)
    manager.submit(job.id, run_ingest(dataset_id))
    return job


@router.get("/datasets/{dataset_id}/download")
def download_dataset(dataset_id: str, db: Session = Depends(get_db)):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    path = store.path_for(ds.object_key)
    if not path.is_file():
        raise HTTPException(410, "object no longer available")
    return FileResponse(str(path), filename=ds.filename)
