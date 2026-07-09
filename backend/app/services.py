"""Job bodies that operate on domain objects."""

from __future__ import annotations

from .db import SessionLocal
from .jobs import JobContext
from .metadata import extract_metadata
from .models import Dataset
from .storage import store


def run_ingest(dataset_id: str):
    """Return a job body that extracts metadata for ``dataset_id``.

    Reads the stored object, parses metadata (no VTK dependency), and writes the
    result back onto the Dataset row, flipping status registered -> ready.
    """

    def body(ctx: JobContext) -> dict:
        ctx.update(progress=0.05, log_line=f"ingest start dataset={dataset_id}")
        with SessionLocal() as db:
            ds = db.get(Dataset, dataset_id)
            if ds is None:
                raise ValueError(f"dataset {dataset_id} not found")
            ds.status = "ingesting"
            db.add(ds)
            db.commit()
            object_path = str(store.path_for(ds.object_key))

        ctx.check_cancelled()
        ctx.update(progress=0.3, log_line="parsing metadata")
        meta = extract_metadata(object_path)
        ctx.check_cancelled()

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
