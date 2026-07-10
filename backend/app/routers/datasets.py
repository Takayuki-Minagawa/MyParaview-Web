from __future__ import annotations

import math
import os
import xml.etree.ElementTree as ET
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath
from typing import Optional

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..bundles import bundle_reference_path as _bundle_reference_path
from ..bundles import safe_relative_path as _safe_relative_path
from ..config import settings
from ..db import get_db
from ..jobs import manager
from ..models import Dataset, DatasetFile, Job, Project
from ..project_locks import locked_project
from ..responses import LeasedFileResponse
from ..schemas import CollectionStepOut, DatasetOut, JobOut
from ..services import run_ingest
from ..storage import store

router = APIRouter(tags=["datasets"])


def _validate_descriptor_reference(primary_path: str, reference: str, manifest: set[str]) -> None:
    raw = reference.strip().strip('"\'')
    if not raw:
        return
    normalized = raw.replace("\\", "/")
    if "://" in normalized or normalized.startswith("file:"):
        raise ValueError(f"external URI is not allowed: {reference!r}")
    if ":" in PurePosixPath(normalized).parts[0]:
        raise ValueError(f"absolute or drive path is not allowed: {reference!r}")
    resolved = _bundle_reference_path(primary_path, normalized)
    if any(character in resolved for character in "*?["):
        if not any(fnmatch(path, resolved) for path in manifest):
            raise ValueError(f"descriptor pattern has no uploaded member: {reference!r}")
    elif resolved not in manifest:
        raise ValueError(f"descriptor reference is missing from upload: {reference!r}")


def _validate_external_descriptor(
    path: str,
    primary_path: str,
    extension: str,
    manifest: set[str],
) -> None:
    references: list[str] = []
    if extension in {".xdmf", ".xmf"}:
        root = SafeET.parse(path).getroot()
        for element in root.iter():
            local_name = element.tag.rsplit("}", 1)[-1]
            if local_name == "DataItem":
                data_format = (element.get("Format") or "XML").upper()
                text = (element.text or "").strip()
                if data_format == "HDF" and text:
                    references.append(text.split(":", 1)[0].strip())
                elif data_format == "BINARY" and text:
                    references.append(text.split()[0])
            if local_name.lower() == "include" and element.get("href"):
                references.append(element.get("href", ""))
    else:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if ":" not in line:
                continue
            candidate = line.split(":", 1)[1].strip().split()
            if not candidate:
                continue
            references.extend(
                value
                for value in candidate
                if any(marker in value for marker in (".", "/", "\\", "*", "?"))
            )
    for reference in references:
        _validate_descriptor_reference(primary_path, reference, manifest)


def _pvd_references(path: str) -> list[str]:
    root = SafeET.parse(path).getroot()
    collection = next(
        (child for child in root if child.tag.rsplit("}", 1)[-1] == "Collection"),
        None,
    )
    if collection is None:
        raise ValueError("PVD has no Collection element")
    datasets = [
        child
        for child in collection
        if child.tag.rsplit("}", 1)[-1] == "DataSet" and child.get("file")
    ]
    references = [child.get("file", "") for child in datasets]
    if not references:
        raise ValueError("PVD collection has no referenced DataSet files")
    seen_times: set[float] = set()
    for child in datasets:
        try:
            timestep = float(child.get("timestep", "0") or "0")
        except ValueError as exc:
            raise ValueError("PVD timestep must be a number") from exc
        if not math.isfinite(timestep):
            raise ValueError("PVD timestep must be finite")
        if timestep in seen_times:
            raise ValueError("browser playback supports one DataSet per timestep")
        seen_times.add(timestep)
    return references


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
    if ext in {".xdmf", ".xmf"}:
        prefix = head.lstrip()[:300].lower()
        return prefix.startswith(b"<?xml") or b"<xdmf" in prefix
    if ext in {".cgns", ".exo", ".e"}:
        return head.startswith(b"\x89HDF\r\n\x1a\n") or head.startswith((b"CDF\x01", b"CDF\x02"))
    if ext == ".case":
        upper = head.upper()
        return b"\x00" not in head and b"FORMAT" in upper and b"GEOMETRY" in upper
    return False


@router.post("/projects/{project_id}/datasets", response_model=DatasetOut, status_code=201)
async def upload_dataset(
    project_id: str,
    file: UploadFile,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "editor")

    filename = os.path.basename(file.filename or "upload")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(415, f"unsupported extension {ext!r}")
    if ext in {".case", ".xdmf", ".xmf"}:
        raise HTTPException(400, "descriptor datasets must be uploaded with all referenced files")

    head = await file.read(4096)
    if not _sniff_ok(ext, head):
        raise HTTPException(400, f"file content does not match a {ext} file")
    await file.seek(0)

    key = store.new_key(ext)
    try:
        try:
            size = store.save_stream(key, file.file, max_bytes=settings.max_upload_bytes)
        except ValueError as exc:
            raise HTTPException(413, str(exc)) from exc
        with locked_project(db, project_id, principal, "editor"):
            ds = Dataset(
                project_id=project_id, filename=filename, ext=ext,
                size_bytes=size, object_key=key, status="registered",
            )
            db.add(ds)
            db.flush()
    except Exception:
        db.rollback()
        store.delete(key)
        raise
    request.state.audit_project_id = project_id
    request.state.audit_resource_type = "dataset"
    request.state.audit_resource_id = ds.id
    return ds


@router.post(
    "/projects/{project_id}/dataset-bundles",
    response_model=DatasetOut,
    status_code=201,
)
async def upload_dataset_bundle(
    project_id: str,
    request: Request,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Register a PVD and every relative file it references as one dataset."""
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "editor")
    if not files:
        raise HTTPException(400, "at least one file is required")

    normalized: list[tuple[str, UploadFile, str]] = []
    seen: set[str] = set()
    for upload in files:
        try:
            relative_path = _safe_relative_path(upload.filename or "")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if relative_path in seen:
            raise HTTPException(400, f"duplicate bundle path {relative_path!r}")
        seen.add(relative_path)
        ext = PurePosixPath(relative_path).suffix.lower()
        if ext not in settings.allowed_extensions:
            raise HTTPException(415, f"unsupported extension {ext!r}")
        normalized.append((relative_path, upload, ext))

    pvd_members = [item for item in normalized if item[2] == ".pvd"]
    if len(pvd_members) != 1:
        raise HTTPException(400, "a dataset bundle requires exactly one .pvd file")
    primary_path = pvd_members[0][0]

    persisted: list[tuple[str, str, int]] = []
    total_size = 0
    try:
        for relative_path, upload, ext in normalized:
            head = await upload.read(4096)
            if not _sniff_ok(ext, head):
                raise HTTPException(400, f"file content does not match a {ext} file: {relative_path}")
            await upload.seek(0)
            remaining = settings.max_upload_bytes - total_size
            if remaining <= 0:
                raise HTTPException(413, f"upload exceeds max_bytes={settings.max_upload_bytes}")
            key = store.new_key(ext)
            try:
                size = store.save_stream(key, upload.file, max_bytes=remaining)
            except ValueError as exc:
                raise HTTPException(413, str(exc)) from exc
            total_size += size
            persisted.append((relative_path, key, size))

        by_path = {relative_path: key for relative_path, key, _ in persisted}
        primary_key = by_path[primary_path]
        try:
            with store.local_path(primary_key) as local_primary:
                references = _pvd_references(str(local_primary))
            resolved_references = [
                _bundle_reference_path(primary_path, reference) for reference in references
            ]
        except (ET.ParseError, DefusedXmlException, ValueError) as exc:
            raise HTTPException(422, f"invalid PVD collection: {exc}") from exc
        missing = sorted({path for path in resolved_references if path not in by_path})
        if missing:
            raise HTTPException(422, f"PVD referenced files are missing: {', '.join(missing)}")
        referenced_extensions = {PurePosixPath(path).suffix.lower() for path in resolved_references}
        if not referenced_extensions.issubset({".vtp", ".vti"}):
            raise HTTPException(422, "PVD browser playback supports only VTP or VTI members")
        if len(referenced_extensions) != 1:
            raise HTTPException(422, "PVD members must use one consistent browser-renderable format")

        with locked_project(db, project_id, principal, "editor"):
            dataset = Dataset(
                project_id=project_id,
                filename=PurePosixPath(primary_path).name,
                ext=".pvd",
                size_bytes=total_size,
                object_key=primary_key,
                status="registered",
            )
            db.add(dataset)
            db.flush()
            for relative_path, key, size in persisted:
                db.add(DatasetFile(
                    dataset_id=dataset.id,
                    relative_path=relative_path,
                    object_key=key,
                    size_bytes=size,
                    is_primary=relative_path == primary_path,
                ))
            db.flush()
        request.state.audit_project_id = project_id
        request.state.audit_resource_type = "dataset"
        request.state.audit_resource_id = dataset.id
        return dataset
    except Exception:
        db.rollback()
        for _, key, _ in persisted:
            store.delete(key)
        raise


@router.post(
    "/projects/{project_id}/external-dataset-bundles",
    response_model=DatasetOut,
    status_code=201,
)
async def upload_external_dataset_bundle(
    project_id: str,
    request: Request,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Upload an EnSight or XDMF descriptor together with its sidecar files."""
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "editor")
    if not files:
        raise HTTPException(400, "at least one file is required")

    normalized: list[tuple[str, UploadFile, str]] = []
    seen: set[str] = set()
    for upload in files:
        try:
            relative_path = _safe_relative_path(upload.filename or "")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if relative_path in seen:
            raise HTTPException(400, f"duplicate bundle path {relative_path!r}")
        seen.add(relative_path)
        ext = PurePosixPath(relative_path).suffix.lower()
        if ext not in settings.external_bundle_extensions:
            raise HTTPException(415, f"unsupported external bundle extension {ext!r}")
        normalized.append((relative_path, upload, ext))

    primaries = [item for item in normalized if item[2] in {".case", ".xdmf", ".xmf"}]
    if len(primaries) != 1:
        raise HTTPException(400, "external bundle requires exactly one .case, .xdmf, or .xmf descriptor")
    primary_path, primary_upload, primary_ext = primaries[0]

    head = await primary_upload.read(4096)
    if not _sniff_ok(primary_ext, head):
        raise HTTPException(400, f"descriptor content does not match {primary_ext}")
    await primary_upload.seek(0)

    persisted: list[tuple[str, str, int]] = []
    total_size = 0
    try:
        for relative_path, upload, ext in normalized:
            remaining = settings.max_upload_bytes - total_size
            if remaining <= 0:
                raise HTTPException(413, f"upload exceeds max_bytes={settings.max_upload_bytes}")
            key = store.new_key(ext)
            try:
                size = store.save_stream(key, upload.file, max_bytes=remaining)
            except ValueError as exc:
                raise HTTPException(413, str(exc)) from exc
            total_size += size
            persisted.append((relative_path, key, size))

        primary_key = next(key for path, key, _ in persisted if path == primary_path)
        try:
            with store.local_path(primary_key) as local_primary:
                _validate_external_descriptor(
                    str(local_primary),
                    primary_path,
                    primary_ext,
                    {path for path, _, _ in persisted},
                )
        except (ET.ParseError, DefusedXmlException, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(422, f"invalid external descriptor: {exc}") from exc
        with locked_project(db, project_id, principal, "editor"):
            dataset = Dataset(
                project_id=project_id,
                filename=PurePosixPath(primary_path).name,
                ext=primary_ext,
                size_bytes=total_size,
                object_key=primary_key,
                status="registered",
            )
            db.add(dataset)
            db.flush()
            for relative_path, key, size in persisted:
                db.add(
                    DatasetFile(
                        dataset_id=dataset.id,
                        relative_path=relative_path,
                        object_key=key,
                        size_bytes=size,
                        is_primary=relative_path == primary_path,
                    )
                )
            db.flush()
        request.state.audit_project_id = project_id
        request.state.audit_resource_type = "dataset"
        request.state.audit_resource_id = dataset.id
        return dataset
    except Exception:
        db.rollback()
        for _, key, _ in persisted:
            store.delete(key)
        raise


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetOut])
def list_datasets(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)
    stmt = select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.created_at.desc())
    return list(db.scalars(stmt))


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
def get_dataset(
    dataset_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, ds.project_id, principal)
    return ds


@router.get("/datasets/{dataset_id}/metadata", response_model=DatasetOut)
def get_metadata(
    dataset_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, ds.project_id, principal)
    return ds


def _collection_entries(dataset: Dataset) -> list[dict]:
    entries = (dataset.extra or {}).get("entries")
    if dataset.dataset_type != "Collection" or not isinstance(entries, list):
        raise HTTPException(409, "dataset is not an ingested PVD collection")
    return [entry for entry in entries if isinstance(entry, dict)]


@router.get("/datasets/{dataset_id}/timesteps", response_model=list[CollectionStepOut])
def list_collection_timesteps(
    dataset_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal)
    entries = _collection_entries(dataset)
    times = list(dataset.timesteps or sorted({float(entry["timestep"]) for entry in entries}))
    return [
        CollectionStepOut(
            index=index,
            time=float(time),
            parts=sorted({int(entry.get("part", 0)) for entry in entries if float(entry["timestep"]) == time}),
            files=[str(entry["file"]) for entry in entries if float(entry["timestep"]) == time],
        )
        for index, time in enumerate(times)
    ]


@router.get("/datasets/{dataset_id}/timesteps/{step_index}/download")
def download_collection_timestep(
    dataset_id: str,
    step_index: int,
    part: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal)
    entries = _collection_entries(dataset)
    times = list(dataset.timesteps or sorted({float(entry["timestep"]) for entry in entries}))
    if step_index < 0 or step_index >= len(times):
        raise HTTPException(404, "timestep not found")
    candidates = [entry for entry in entries if float(entry["timestep"]) == times[step_index]]
    if part is None and candidates:
        part = min(int(entry.get("part", 0)) for entry in candidates)
    selected = next((entry for entry in candidates if int(entry.get("part", 0)) == part), None)
    if selected is None:
        raise HTTPException(404, "timestep part not found")

    primary = db.scalar(
        select(DatasetFile).where(
            DatasetFile.dataset_id == dataset_id,
            DatasetFile.is_primary.is_(True),
        )
    )
    if primary is None:
        raise HTTPException(410, "collection manifest is unavailable")
    try:
        relative_path = _bundle_reference_path(primary.relative_path, str(selected["file"]))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    member = db.scalar(
        select(DatasetFile).where(
            DatasetFile.dataset_id == dataset_id,
            DatasetFile.relative_path == relative_path,
        )
    )
    if member is None or not store.exists(member.object_key):
        raise HTTPException(410, "timestep object is unavailable")
    path = store.acquire_path(member.object_key)
    if not path.is_file():
        store.release_path(member.object_key)
        raise HTTPException(410, "timestep object is unavailable")
    return LeasedFileResponse(
        str(path),
        store=store,
        object_key=member.object_key,
        filename=PurePosixPath(relative_path).name,
    )


@router.post("/datasets/{dataset_id}/ingest", response_model=JobOut, status_code=202)
def ingest_dataset(
    dataset_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    project_id = ds.project_id
    with locked_project(db, project_id, principal, "editor"):
        ds = db.get(Dataset, dataset_id)
        if ds is None or ds.project_id != project_id:
            raise HTTPException(404, "dataset not found")
        job = Job(project_id=project_id, kind="ingest", status="queued", target_id=dataset_id)
        db.add(job)
        db.flush()
    manager.submit(job.id, run_ingest(dataset_id))
    return job


@router.get("/datasets/{dataset_id}/download")
def download_dataset(
    dataset_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, ds.project_id, principal)
    path = store.acquire_path(ds.object_key)
    if not path.is_file():
        store.release_path(ds.object_key)
        raise HTTPException(410, "object no longer available")
    return LeasedFileResponse(
        str(path),
        store=store,
        object_key=ds.object_key,
        filename=ds.filename,
    )
