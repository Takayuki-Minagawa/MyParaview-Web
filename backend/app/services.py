"""Job bodies that operate on domain objects."""

from __future__ import annotations

from typing import Optional

from .db import SessionLocal
from .jobs import JobCancelled, JobContext
from .metadata import extract_metadata
from .models import Dataset
from .storage import store


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
            object_path = str(store.path_for(ds.object_key))

        try:
            ctx.check_cancelled()
            ctx.update(progress=0.3, log_line="parsing metadata")
            meta = extract_metadata(object_path)
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
