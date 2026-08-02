"""Job bodies that operate on domain objects."""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from sqlalchemy import select

from .bundles import bundle_reference_path, materialized_bundle_path
from .config import settings
from .db import SessionLocal
from .jobs import JobCancelled, JobContext
from .metadata import extract_metadata
from .models import Artifact, Dataset, DatasetFile, Job, Pipeline
from .project_locks import locked_project
from .stats import compute_dataset_statistics
from .storage import store
from .worker import (
    extract_external_metadata,
    run_movie_frames,
    run_movie_video,
    run_pipeline_transform,
    run_transform,
)


def _set_dataset_status(dataset_id: str, status: str, *, error: Optional[str]) -> None:
    with SessionLocal() as db:
        ds = db.get(Dataset, dataset_id)
        if ds is None:
            return
        ds.status = status
        ds.error = error
        db.add(ds)
        db.commit()


def _materialize_ingest_member(root: Path, relative_path: str, object_key: str) -> Path:
    """Copy one bundle member from the object store under ``root``."""
    target = materialized_bundle_path(root, relative_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with store.local_path(object_key) as local_object:
        shutil.copyfile(local_object, target)
    return target


def _enrich_pvd_first_sibling(
    dataset_id: str, root: Path, primary_path: Path, primary_relative_path: str
):
    """Re-extract PVD metadata with its first referenced piece materialized.

    A PVD descriptor alone yields only collection structure; sampling the
    first referenced file adds array/bounds detail. Returns the richer
    metadata, or the descriptor-only metadata when the sibling row is absent.
    """
    meta = extract_metadata(str(primary_path))
    referenced = list(meta.extra.get("files") or [])
    if not referenced or not primary_relative_path:
        return meta
    first_relative = bundle_reference_path(primary_relative_path, str(referenced[0]))
    with SessionLocal() as db:
        first_object_key = db.scalar(
            select(DatasetFile.object_key).where(
                DatasetFile.dataset_id == dataset_id,
                DatasetFile.relative_path == first_relative,
            )
        )
    if not first_object_key:
        return meta
    _materialize_ingest_member(root, first_relative, first_object_key)
    return extract_metadata(str(primary_path), pvd_enrich_siblings=True)


def _ingest_bundle_metadata(
    ctx: JobContext, dataset_id: str, source_ext: str, bundle_files: list[tuple[str, str, bool]]
):
    """Materialize a bundle into a temp dir and extract its metadata."""
    with tempfile.TemporaryDirectory(prefix="pvweb-bundle-") as temp_dir:
        root = Path(temp_dir).resolve()
        primary_path: Path | None = None
        primary_relative_path: str | None = None
        for relative_path, object_key, is_primary in bundle_files:
            target = _materialize_ingest_member(root, relative_path, object_key)
            if is_primary:
                if primary_path is not None:
                    raise ValueError("dataset bundle has multiple primary files")
                primary_path = target
                primary_relative_path = relative_path
        if primary_path is None:
            raise ValueError("dataset bundle has no primary file")
        if source_ext == ".pvd":
            return _enrich_pvd_first_sibling(
                dataset_id, root, primary_path, primary_relative_path
            )
        if source_ext in settings.external_extensions:
            return extract_external_metadata(primary_path, ctx)
        return extract_metadata(str(primary_path))


def _ingest_single_metadata(ctx: JobContext, source_object_key: str, source_ext: str):
    """Extract metadata for a single stored object (no bundle members)."""
    with store.local_path(source_object_key) as local_object:
        if source_ext in settings.external_extensions:
            return extract_external_metadata(local_object, ctx)
        # A standalone PVD has no sibling rows to materialize, so sibling
        # enrichment must stay off; the flag is ignored for other formats.
        return extract_metadata(str(local_object), pvd_enrich_siblings=False)


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
                meta = _ingest_bundle_metadata(ctx, dataset_id, source_ext, bundle_files)
            else:
                meta = _ingest_single_metadata(ctx, source_object_key, source_ext)
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


@dataclass(frozen=True)
class _DatasetSource:
    """Snapshot of the dataset row a job body operates on."""

    object_key: str
    project_id: str
    filename: str
    ext: str
    # (relative_path, object_key, is_primary) rows from DatasetFile
    bundle_files: list[tuple[str, str, bool]]


@dataclass(frozen=True)
class _OutputPlan:
    """Derived naming/routing decisions for a dataset operation."""

    filename: str
    output_ext: str
    artifact_kind: str
    is_bundle_export: bool
    needs_worker: bool


def _load_dataset_source(dataset_id: str) -> _DatasetSource:
    with SessionLocal() as db:
        dataset = db.get(Dataset, dataset_id)
        if dataset is None:
            raise ValueError(f"dataset {dataset_id} not found")
        bundle_files = list(
            db.execute(
                select(
                    DatasetFile.relative_path,
                    DatasetFile.object_key,
                    DatasetFile.is_primary,
                ).where(DatasetFile.dataset_id == dataset_id)
            ).all()
        )
        return _DatasetSource(
            object_key=dataset.object_key,
            project_id=dataset.project_id,
            filename=dataset.filename,
            ext=dataset.ext,
            bundle_files=bundle_files,
        )


_PLAN_SUFFIX = {"filter": "filtered", "convert": "converted", "render": "render"}


def _stem(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename))[0]


def _plan_output(kind: str, params: dict, source: _DatasetSource) -> _OutputPlan:
    output_format = str(params.get("output_format", "source")).lower()
    if kind == "export" and output_format != "source":
        raise ValueError("export jobs only support output_format='source'")
    if kind == "convert" and output_format != "vtp":
        raise ValueError("convert jobs require output_format='vtp'")

    is_bundle_export = kind == "export" and bool(source.bundle_files)
    needs_worker = kind in {"filter", "render"} or (kind == "convert" and source.ext != ".vtp")
    if is_bundle_export:
        output_ext = ".zip"
    elif kind in {"filter", "convert"}:
        output_ext = ".vtp"
    elif kind == "render":
        output_ext = ".png"
    else:
        output_ext = source.ext
    stem = _stem(source.filename)
    suffix = _PLAN_SUFFIX.get(kind, "export")
    if kind == "filter":
        artifact_kind = "filtered_vtp"
    elif kind == "render":
        artifact_kind = "render_png"
    elif kind == "convert" and output_ext == ".vtp":
        artifact_kind = "converted_vtp"
    else:
        artifact_kind = kind
    return _OutputPlan(
        filename=f"{stem}-{suffix}{output_ext}",
        output_ext=output_ext,
        artifact_kind=artifact_kind,
        is_bundle_export=is_bundle_export,
        needs_worker=needs_worker,
    )


def materialize_bundle(bundle_files: list[tuple[str, str, bool]], root: Path) -> Path:
    """Copy bundle members under ``root`` and return the primary file path."""
    primary: Path | None = None
    for relative_path, bundle_object_key, is_primary in bundle_files:
        target = materialized_bundle_path(root, relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with store.local_path(bundle_object_key) as local_object:
            shutil.copyfile(local_object, target)
        if is_primary:
            primary = target
    if primary is None:
        raise ValueError("dataset bundle has no primary file")
    return primary


def _produce_object(
    ctx: JobContext,
    kind: str,
    params: dict,
    source: _DatasetSource,
    plan: _OutputPlan,
    object_key: str,
    source_path: Path,
) -> int:
    """Write the derived object to ``object_key`` and return its size."""
    if plan.is_bundle_export:
        ctx.update(progress=0.35, log_line="packaging dataset bundle")
        with tempfile.TemporaryDirectory(prefix="pvweb-export-") as export_dir:
            archive_path = Path(export_dir) / plan.filename
            with zipfile.ZipFile(
                archive_path, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                for relative_path, bundle_object_key, _ in source.bundle_files:
                    ctx.check_cancelled()
                    with store.local_path(bundle_object_key) as local_object:
                        archive.write(local_object, arcname=relative_path)
            return store.copy_in(object_key, archive_path)
    if plan.needs_worker:
        ctx.update(progress=0.25, log_line=f"running ParaView {kind} worker")
        with tempfile.TemporaryDirectory(prefix="pvweb-worker-") as worker_dir:
            root = Path(worker_dir).resolve()
            worker_source = (
                materialize_bundle(source.bundle_files, root)
                if source.bundle_files
                else source_path
            )
            worker_output = root / plan.filename
            run_transform(Path(worker_source), worker_output, kind, params, ctx)
            return store.copy_in(object_key, worker_output)
    ctx.update(progress=0.35, log_line="copying source object")
    return store.copy_in(object_key, source_path)


def persist_job_artifact(
    ctx: JobContext,
    *,
    project_id: str,
    dataset_id: Optional[str],
    kind: str,
    filename: str,
    size: int,
    object_key: str,
    content_type: str,
) -> str:
    """Create the Artifact row inside a project lock, revalidating ownership."""
    with SessionLocal() as db:
        with locked_project(db, project_id):
            current_job = db.get(Job, ctx.job_id)
            current_dataset = db.get(Dataset, dataset_id) if dataset_id else None
            if (
                (dataset_id is not None and (
                    current_dataset is None or current_dataset.project_id != project_id
                ))
                or current_job is None
                or current_job.project_id != project_id
            ):
                raise ValueError("project was deleted while creating artifact")
            artifact = Artifact(
                dataset_id=dataset_id,
                job_id=ctx.job_id,
                kind=kind,
                filename=filename,
                size_bytes=size,
                object_key=object_key,
                content_type=content_type,
            )
            db.add(artifact)
            db.flush()
            return artifact.id


def rollback_job_artifact(artifact_id: Optional[str], object_key: str) -> None:
    """Delete a partially published artifact row and its stored object."""
    if artifact_id is not None:
        with SessionLocal() as db:
            artifact = db.get(Artifact, artifact_id)
            if artifact is not None:
                db.delete(artifact)
                db.commit()
    store.delete(object_key)


@dataclass(frozen=True)
class _ArtifactSpec:
    """Naming/typing decisions for one artifact-producing job."""

    filename: str
    output_ext: str
    kind: str
    content_type: str


# Writes the output object for (source_path, object_key) and returns
# (stored size, extra fields to merge into the job result).
_Producer = Callable[[Optional[Path], str], "tuple[int, dict]"]


def _run_artifact_job(
    ctx: JobContext,
    dataset_id: str,
    *,
    start_log: str,
    done_noun: str = "artifact",
    needs_source_path: bool = True,
    plan: Callable[[_DatasetSource], "tuple[_ArtifactSpec, _Producer]"],
) -> dict:
    """Shared skeleton for jobs that publish exactly one artifact.

    Owns the invariants every such job must repeat identically: dataset
    snapshot, output-key allocation, the optional source lease, artifact
    persistence, rollback of a partially published artifact on failure, and
    the final progress update. ``plan`` sees the dataset snapshot and returns
    the artifact naming plus the producer that writes the object bytes.
    """
    ctx.update(progress=0.05, log_line=start_log)
    source = _load_dataset_source(dataset_id)
    ctx.check_cancelled()
    spec, produce = plan(source)
    object_key = store.new_key(spec.output_ext)
    artifact_id: Optional[str] = None
    source_path = store.acquire_path(source.object_key) if needs_source_path else None
    try:
        size, extra = produce(source_path, object_key)
        ctx.check_cancelled()
        artifact_id = persist_job_artifact(
            ctx,
            project_id=source.project_id,
            dataset_id=dataset_id,
            kind=spec.kind,
            filename=spec.filename,
            size=size,
            object_key=object_key,
            content_type=spec.content_type,
        )
        ctx.check_cancelled()
        ctx.update(progress=1.0, log_line=f"{done_noun} created id={artifact_id}")
        result = {
            "project_id": source.project_id,
            "dataset_id": dataset_id,
            "artifact_id": artifact_id,
            "filename": spec.filename,
            "size_bytes": size,
        }
        result.update(extra)
        return result
    except Exception:
        rollback_job_artifact(artifact_id, object_key)
        raise
    finally:
        if needs_source_path:
            store.release_path(source.object_key)


def run_stats_operation(dataset_id: str, params: dict):
    """Compute per-array statistics and publish them as a JSON artifact."""

    def body(ctx: JobContext) -> dict:
        bins = int(params.get("bins", 32))

        def plan(source: _DatasetSource):
            spec = _ArtifactSpec(
                filename=f"{_stem(source.filename)}-stats.json",
                output_ext=".json",
                kind="stats_json",
                content_type="application/json",
            )

            def produce(_source_path: Optional[Path], object_key: str):
                ctx.update(progress=0.3, log_line="computing array statistics")
                with store.local_path(source.object_key) as local_object:
                    arrays = compute_dataset_statistics(str(local_object), source.ext, bins)
                ctx.check_cancelled()
                payload = {"dataset_id": dataset_id, "bins": bins, "arrays": arrays}
                size = store.save_bytes(
                    object_key, json.dumps(payload, allow_nan=False).encode()
                )
                return size, {}

            return spec, produce

        return _run_artifact_job(
            ctx,
            dataset_id,
            start_log=f"stats start dataset={dataset_id}",
            done_noun="statistics artifact",
            needs_source_path=False,
            plan=plan,
        )

    return body


def run_movie_export(dataset_id: str, params: dict):
    """Render timestep frames into the legacy ZIP or a fixed-codec video."""

    def body(ctx: JobContext) -> dict:
        def plan(source: _DatasetSource):
            output_format = params.get("format", "zip")
            if output_format not in {"zip", "mp4", "webm"}:
                raise ValueError("movie format must be zip, mp4, or webm")
            fps = int(params.get("fps", 24))
            movie_params = {**params, "format": output_format, "fps": fps}
            video_specs = {
                "mp4": (".mp4", "video/mp4"),
                "webm": (".webm", "video/webm"),
            }
            output_ext, content_type = video_specs.get(
                output_format, (".zip", "application/zip")
            )
            spec = _ArtifactSpec(
                filename=f"{_stem(source.filename)}-movie{output_ext}",
                output_ext=output_ext,
                kind="movie_frames" if output_format == "zip" else "movie_video",
                content_type=content_type,
            )

            def produce(source_path: Optional[Path], object_key: str):
                with tempfile.TemporaryDirectory(prefix="pvweb-movie-") as movie_dir:
                    root = Path(movie_dir).resolve()
                    worker_source = (
                        materialize_bundle(source.bundle_files, root / "bundle")
                        if source.bundle_files
                        else source_path
                    )
                    ctx.update(progress=0.2, log_line="rendering timestep frames")
                    if output_format == "zip":
                        frames = run_movie_frames(
                            Path(worker_source), root / "frames", movie_params, ctx
                        )
                        ctx.check_cancelled()
                        ctx.update(
                            progress=0.8,
                            log_line=f"packaging {len(frames)} frames",
                        )
                        output_path = root / spec.filename
                        with zipfile.ZipFile(
                            output_path, "w", compression=zipfile.ZIP_DEFLATED
                        ) as archive:
                            for frame in frames:
                                archive.write(frame, arcname=frame.name)
                        frame_count = len(frames)
                    else:
                        ctx.update(
                            progress=0.4,
                            log_line=f"encoding {output_format} at {fps} fps",
                        )
                        output_path = root / spec.filename
                        frame_count = run_movie_video(
                            Path(worker_source), output_path, movie_params, ctx
                        )
                    ctx.check_cancelled()
                    size = store.copy_in(object_key, output_path)
                return size, {
                    "frame_count": frame_count,
                    "format": output_format,
                    "fps": fps,
                }

            return spec, produce

        return _run_artifact_job(
            ctx,
            dataset_id,
            start_log=f"movie start dataset={dataset_id}",
            done_noun="movie artifact",
            plan=plan,
        )

    return body


def load_pipeline_chain(db, pipeline_id: str) -> tuple[str, list]:
    """Resolve a pipeline into (reader dataset id, ordered filter nodes).

    Execution supports a linear reader -> filter* chain; representation nodes
    are display-only and skipped. Raises ValueError for shapes that cannot run.
    """
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise ValueError("pipeline not found")
    nodes = list(pipeline.nodes)
    readers = [node for node in nodes if node.node_type == "reader"]
    if len(readers) != 1:
        raise ValueError("pipeline execution requires exactly one reader node")
    reader = readers[0]
    if not reader.dataset_id:
        raise ValueError("pipeline reader has no dataset")
    consumers: dict[str, list] = {}
    for node in nodes:
        if node.input_id:
            consumers.setdefault(node.input_id, []).append(node)
    chain = []
    current = reader
    visited = {reader.id}
    while True:
        next_filters = [
            node for node in consumers.get(current.id, []) if node.node_type == "filter"
        ]
        if not next_filters:
            break
        if len(next_filters) > 1:
            raise ValueError("pipeline execution supports a single linear filter chain")
        current = next_filters[0]
        if current.id in visited:
            raise ValueError("pipeline filter chain contains a cycle")
        visited.add(current.id)
        chain.append(current)
    if not chain:
        raise ValueError("pipeline has no filter nodes to execute")
    return reader.dataset_id, chain


def run_pipeline_execution(pipeline_id: str, dataset_id: str, filters: list[dict]):
    """Execute a stored pipeline's filter chain and publish the final VTP."""

    def body(ctx: JobContext) -> dict:
        def plan(source: _DatasetSource):
            spec = _ArtifactSpec(
                filename=f"{_stem(source.filename)}-pipeline.vtp",
                output_ext=".vtp",
                kind="pipeline_vtp",
                content_type="application/octet-stream",
            )

            def produce(source_path: Optional[Path], object_key: str):
                with tempfile.TemporaryDirectory(prefix="pvweb-pipeline-") as work_dir:
                    root = Path(work_dir).resolve()
                    current = (
                        materialize_bundle(source.bundle_files, root / "bundle")
                        if source.bundle_files
                        else source_path
                    )
                    filter_names = ", ".join(str(item.get("filter")) for item in filters)
                    ctx.update(
                        progress=0.1,
                        log_line=f"applying {len(filters)} pipeline filters: {filter_names}",
                    )
                    worker_output = root / spec.filename
                    run_pipeline_transform(Path(current), worker_output, filters, ctx)
                    ctx.update(progress=0.8, log_line="pipeline filters complete")
                    size = store.copy_in(object_key, worker_output)
                return size, {"pipeline_id": pipeline_id}

            return spec, produce

        return _run_artifact_job(
            ctx,
            dataset_id,
            start_log=f"pipeline start pipeline={pipeline_id}",
            done_noun="pipeline artifact",
            plan=plan,
        )

    return body


def run_dataset_operation(dataset_id: str, kind: str, params: dict):
    """Create a derived artifact through the generic job contract.

    Source export works in-process. Conversion and validated server filters use
    the separately configured ParaView worker and fail explicitly when that
    capability is unavailable.
    """

    def body(ctx: JobContext) -> dict:
        def plan(source: _DatasetSource):
            output = _plan_output(kind, params, source)
            spec = _ArtifactSpec(
                filename=output.filename,
                output_ext=output.output_ext,
                kind=output.artifact_kind,
                content_type=(
                    "application/zip"
                    if output.is_bundle_export
                    else mimetypes.guess_type(output.filename)[0] or "application/octet-stream"
                ),
            )

            def produce(source_path: Optional[Path], object_key: str):
                size = _produce_object(ctx, kind, params, source, output, object_key, source_path)
                return size, {}

            return spec, produce

        return _run_artifact_job(
            ctx,
            dataset_id,
            start_log=f"{kind} start dataset={dataset_id}",
            plan=plan,
        )

    return body
