"""Job bodies that operate on domain objects."""

from __future__ import annotations

import mimetypes
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Optional

from sqlalchemy import select

from .bundles import bundle_reference_path, materialized_bundle_path
from .config import settings
from .db import SessionLocal
from .jobs import JobCancelled, JobContext
from .metadata import extract_metadata
from .models import Artifact, Dataset, DatasetFile, Job
from .project_locks import locked_project
from .storage import store
from .worker import extract_external_metadata, run_transform


def _set_dataset_status(dataset_id: str, status: str, *, error: Optional[str]) -> None:
    with SessionLocal() as db:
        ds = db.get(Dataset, dataset_id)
        if ds is None:
            return
        ds.status = status
        ds.error = error
        db.add(ds)
        db.commit()


def run_ingest(dataset_id: str):
    """Return a job body that extracts metadata for ``dataset_id``.

    Reads the stored object, parses metadata (no VTK dependency), and writes the
    result back onto the Dataset row, flipping status registered -> ready.

    On failure the Dataset is moved to ``error`` (with the message) and on
    cancellation back to ``registered`` — the JobManager only tracks the Job
    itself, so without this the Dataset would be stuck at ``ingesting`` forever.
    """

    def body(ctx: JobContext) -> dict:
        ctx.update(progress=0.05, log_line=f"ingest start dataset={dataset_id}")
        with SessionLocal() as db:
            ds = db.get(Dataset, dataset_id)
            if ds is None:
                raise ValueError(f"dataset {dataset_id} not found")
            ds.status = "ingesting"
            ds.error = None
            db.add(ds)
            db.commit()
            source_object_key = ds.object_key
            source_ext = ds.ext
            bundle_query = select(
                DatasetFile.relative_path,
                DatasetFile.object_key,
                DatasetFile.is_primary,
            ).where(DatasetFile.dataset_id == dataset_id)
            if source_ext == ".pvd":
                # Metadata needs only the descriptor and its first piece. Do
                # not copy an entire time-series into a temporary directory.
                bundle_query = bundle_query.where(DatasetFile.is_primary.is_(True))
            bundle_files = list(db.execute(bundle_query).all())

        try:
            ctx.check_cancelled()
            ctx.update(progress=0.3, log_line="parsing metadata")
            if bundle_files:
                with tempfile.TemporaryDirectory(prefix="pvweb-bundle-") as temp_dir:
                    root = Path(temp_dir).resolve()
                    primary_path: Path | None = None
                    primary_relative_path: str | None = None
                    for relative_path, object_key, is_primary in bundle_files:
                        target = materialized_bundle_path(root, relative_path)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with store.local_path(object_key) as local_object:
                            shutil.copyfile(local_object, target)
                        if is_primary:
                            if primary_path is not None:
                                raise ValueError("dataset bundle has multiple primary files")
                            primary_path = target
                            primary_relative_path = relative_path
                    if primary_path is None:
                        raise ValueError("dataset bundle has no primary file")
                    if source_ext == ".pvd":
                        meta = extract_metadata(str(primary_path))
                        referenced = list(meta.extra.get("files") or [])
                        if referenced and primary_relative_path:
                            first_relative = bundle_reference_path(
                                primary_relative_path, str(referenced[0])
                            )
                            with SessionLocal() as db:
                                first_object_key = db.scalar(
                                    select(DatasetFile.object_key).where(
                                        DatasetFile.dataset_id == dataset_id,
                                        DatasetFile.relative_path == first_relative,
                                    )
                                )
                            if first_object_key:
                                first_target = materialized_bundle_path(root, first_relative)
                                first_target.parent.mkdir(parents=True, exist_ok=True)
                                with store.local_path(first_object_key) as local_object:
                                    shutil.copyfile(local_object, first_target)
                                meta = extract_metadata(
                                    str(primary_path), pvd_enrich_siblings=True
                                )
                    else:
                        meta = (
                            extract_external_metadata(primary_path, ctx)
                            if source_ext in settings.external_extensions
                            else extract_metadata(str(primary_path))
                        )
            else:
                with store.local_path(source_object_key) as local_object:
                    meta = (
                        extract_external_metadata(local_object, ctx)
                        if source_ext in settings.external_extensions
                        else extract_metadata(
                            str(local_object),
                            pvd_enrich_siblings=source_ext != ".pvd",
                        )
                    )
            if source_ext == ".pvd":
                # A standalone PVD can provide useful collection metadata, but
                # playback is only enabled for a server-validated full bundle.
                meta.extra["bundle_complete"] = bool(bundle_files)
            ctx.check_cancelled()
        except JobCancelled:
            # revert so the dataset is not left displaying "ingesting"
            _set_dataset_status(dataset_id, "registered", error=None)
            raise
        except Exception as exc:  # noqa: BLE001 - surface the failure on the dataset
            _set_dataset_status(dataset_id, "error", error=str(exc))
            raise

        payload = meta.to_dict()
        with SessionLocal() as db:
            ds = db.get(Dataset, dataset_id)
            if ds is None:
                raise ValueError(f"dataset {dataset_id} disappeared during ingest")
            ds.dataset_type = meta.dataset_type
            ds.num_points = meta.num_points
            ds.num_cells = meta.num_cells
            ds.num_blocks = meta.num_blocks
            ds.bounds = meta.bounds
            ds.timesteps = meta.timesteps
            ds.arrays = [a.__dict__ for a in meta.arrays]
            ds.extra = meta.extra or None
            ds.status = "ready"
            ds.error = None
            db.add(ds)
            db.commit()

        ctx.update(progress=1.0, log_line=f"ingest done type={meta.dataset_type}")
        return {"dataset_id": dataset_id, "metadata": payload}

    return body


def run_dataset_operation(dataset_id: str, kind: str, params: dict):
    """Create a derived artifact through the generic job contract.

    Source export works in-process. Conversion and validated server filters use
    the separately configured ParaView worker and fail explicitly when that
    capability is unavailable.
    """

    def body(ctx: JobContext) -> dict:
        ctx.update(progress=0.05, log_line=f"{kind} start dataset={dataset_id}")
        with SessionLocal() as db:
            dataset = db.get(Dataset, dataset_id)
            if dataset is None:
                raise ValueError(f"dataset {dataset_id} not found")
            source_object_key = dataset.object_key
            project_id = dataset.project_id
            source_name = dataset.filename
            source_ext = dataset.ext
            bundle_files = list(
                db.execute(
                    select(
                        DatasetFile.relative_path,
                        DatasetFile.object_key,
                        DatasetFile.is_primary,
                    ).where(
                        DatasetFile.dataset_id == dataset_id
                    )
                ).all()
            )

        ctx.check_cancelled()
        output_format = str(params.get("output_format", "source")).lower()
        if kind == "export" and output_format != "source":
            raise ValueError("export jobs only support output_format='source'")
        if kind == "convert" and output_format != "vtp":
            raise ValueError("convert jobs require output_format='vtp'")

        is_bundle_export = kind == "export" and bool(bundle_files)
        needs_worker = kind == "filter" or (kind == "convert" and source_ext != ".vtp")
        output_ext = (
            ".zip"
            if is_bundle_export
            else (".vtp" if kind in {"filter", "convert"} else source_ext)
        )
        stem = os.path.splitext(os.path.basename(source_name))[0]
        suffix = "filtered" if kind == "filter" else ("converted" if kind == "convert" else "export")
        filename = f"{stem}-{suffix}{output_ext}"
        artifact_kind = (
            "filtered_vtp" if kind == "filter" else
            ("converted_vtp" if output_ext == ".vtp" and kind == "convert" else kind)
        )
        object_key = store.new_key(output_ext)
        persisted = False
        artifact_id: Optional[str] = None
        source_path = store.acquire_path(source_object_key)
        try:
            if is_bundle_export:
                ctx.update(progress=0.35, log_line="packaging dataset bundle")
                with tempfile.TemporaryDirectory(prefix="pvweb-export-") as export_dir:
                    archive_path = Path(export_dir) / filename
                    with zipfile.ZipFile(
                        archive_path, "w", compression=zipfile.ZIP_DEFLATED
                    ) as archive:
                        for relative_path, bundle_object_key, _ in bundle_files:
                            ctx.check_cancelled()
                            with store.local_path(bundle_object_key) as local_object:
                                archive.write(local_object, arcname=relative_path)
                    size = store.copy_in(object_key, archive_path)
            elif needs_worker:
                ctx.update(progress=0.25, log_line=f"running ParaView {kind} worker")
                with tempfile.TemporaryDirectory(prefix="pvweb-worker-") as worker_dir:
                    root = Path(worker_dir).resolve()
                    worker_source = source_path
                    if bundle_files:
                        worker_source = None
                        for relative_path, bundle_object_key, is_primary in bundle_files:
                            target = materialized_bundle_path(root, relative_path)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with store.local_path(bundle_object_key) as local_object:
                                shutil.copyfile(local_object, target)
                            if is_primary:
                                worker_source = target
                        if worker_source is None:
                            raise ValueError("dataset bundle has no primary file")
                    worker_output = root / filename
                    run_transform(Path(worker_source), worker_output, kind, params, ctx)
                    size = store.copy_in(object_key, worker_output)
            else:
                ctx.update(progress=0.35, log_line="copying source object")
                size = store.copy_in(object_key, source_path)
            ctx.check_cancelled()
            content_type = (
                "application/zip"
                if is_bundle_export
                else mimetypes.guess_type(filename)[0] or "application/octet-stream"
            )
            with SessionLocal() as db:
                with locked_project(db, project_id):
                    current_dataset = db.get(Dataset, dataset_id)
                    current_job = db.get(Job, ctx.job_id)
                    if (
                        current_dataset is None
                        or current_dataset.project_id != project_id
                        or current_job is None
                        or current_job.project_id != project_id
                    ):
                        raise ValueError("project was deleted while creating artifact")
                    artifact = Artifact(
                        dataset_id=dataset_id,
                        job_id=ctx.job_id,
                        kind=artifact_kind,
                        filename=filename,
                        size_bytes=size,
                        object_key=object_key,
                        content_type=content_type,
                    )
                    db.add(artifact)
                    db.flush()
                    artifact_id = artifact.id
            persisted = True
            ctx.check_cancelled()
            ctx.update(progress=1.0, log_line=f"artifact created id={artifact_id}")
            return {
                "project_id": project_id,
                "dataset_id": dataset_id,
                "artifact_id": artifact_id,
                "filename": filename,
                "size_bytes": size,
            }
        except JobCancelled:
            if artifact_id is not None:
                with SessionLocal() as db:
                    artifact = db.get(Artifact, artifact_id)
                    if artifact is not None:
                        db.delete(artifact)
                        db.commit()
            store.delete(object_key)
            raise
        except Exception:
            if persisted and artifact_id is not None:
                with SessionLocal() as db:
                    artifact = db.get(Artifact, artifact_id)
                    if artifact is not None:
                        db.delete(artifact)
                        db.commit()
            store.delete(object_key)
            raise
        finally:
            store.release_path(source_object_key)

    return body
