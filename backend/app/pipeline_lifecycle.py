"""Database lifecycle helpers for self-referential pipeline graphs."""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .models import Pipeline, PipelineNode


def detach_pipeline_inputs(
    db: Session,
    *,
    pipeline_id: str | None = None,
    project_id: str | None = None,
) -> None:
    """Break graph edges before deleting/replacing pipeline nodes.

    The database FK is also ``ON DELETE SET NULL`` as a final boundary. This
    explicit update keeps existing pre-migration databases and ORM delete order
    deterministic while rolling deployments are upgraded.
    """
    if (pipeline_id is None) == (project_id is None):
        raise ValueError("exactly one pipeline scope is required")
    predicate = PipelineNode.pipeline_id == pipeline_id
    if project_id is not None:
        predicate = PipelineNode.pipeline_id.in_(
            select(Pipeline.id).where(Pipeline.project_id == project_id)
        )
    db.execute(update(PipelineNode).where(predicate).values(input_id=None))
    db.flush()
