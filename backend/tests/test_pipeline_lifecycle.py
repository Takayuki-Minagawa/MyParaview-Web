"""Edge-detach behavior of detach_pipeline_inputs (app/pipeline_lifecycle.py)."""

from __future__ import annotations

import uuid

import pytest

from app.db import SessionLocal
from app.models import Dataset, Pipeline, PipelineNode, Project
from app.pipeline_lifecycle import detach_pipeline_inputs


def _build_pipeline(db, project_id: str, name: str) -> tuple[str, str, str]:
    """Create dataset -> reader -> filter chain; return (dataset, reader, filter) ids."""
    dataset = Dataset(
        project_id=project_id,
        filename=f"{name}.vtp",
        ext=".vtp",
        object_key=f"{name}-{uuid.uuid4().hex}.vtp",
    )
    pipeline = Pipeline(project_id=project_id, name=name)
    db.add_all([dataset, pipeline])
    db.flush()
    reader = PipelineNode(
        pipeline_id=pipeline.id, node_type="reader", name="reader", dataset_id=dataset.id
    )
    db.add(reader)
    db.flush()
    filter_node = PipelineNode(
        pipeline_id=pipeline.id, node_type="filter", name="clip", input_id=reader.id
    )
    db.add(filter_node)
    db.flush()
    return dataset.id, reader.id, filter_node.id


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"pipeline_id": "p", "project_id": "q"},
    ],
)
def test_detach_requires_exactly_one_scope(client, kwargs):
    with SessionLocal() as db:
        with pytest.raises(ValueError, match="exactly one pipeline scope"):
            detach_pipeline_inputs(db, **kwargs)


def test_detach_by_pipeline_clears_inputs_but_keeps_dataset_edges(client):
    with SessionLocal() as db:
        project = Project(name=f"detach-pipeline-{uuid.uuid4().hex[:8]}")
        db.add(project)
        db.flush()
        target = _build_pipeline(db, project.id, "target")
        other = _build_pipeline(db, project.id, "other")
        db.commit()
        target_pipeline_id = db.get(PipelineNode, target[1]).pipeline_id

        try:
            detach_pipeline_inputs(db, pipeline_id=target_pipeline_id)
            db.commit()
            db.expire_all()

            target_filter = db.get(PipelineNode, target[2])
            assert target_filter.input_id is None
            # Dataset references survive a single-pipeline replacement.
            assert db.get(PipelineNode, target[1]).dataset_id == target[0]
            # Nodes in a sibling pipeline are untouched.
            assert db.get(PipelineNode, other[2]).input_id == other[1]
            assert db.get(PipelineNode, other[1]).dataset_id == other[0]
        finally:
            db.delete(db.get(Project, project.id))
            db.commit()


def test_detach_by_project_clears_input_and_dataset_edges(client):
    with SessionLocal() as db:
        doomed = Project(name=f"detach-project-{uuid.uuid4().hex[:8]}")
        untouched = Project(name=f"detach-bystander-{uuid.uuid4().hex[:8]}")
        db.add_all([doomed, untouched])
        db.flush()
        first = _build_pipeline(db, doomed.id, "first")
        second = _build_pipeline(db, doomed.id, "second")
        bystander = _build_pipeline(db, untouched.id, "bystander")
        db.commit()

        try:
            detach_pipeline_inputs(db, project_id=doomed.id)
            db.commit()
            db.expire_all()

            for _dataset_id, reader_id, filter_id in (first, second):
                assert db.get(PipelineNode, reader_id).dataset_id is None
                assert db.get(PipelineNode, filter_id).input_id is None
            # Another project's graph keeps both edge kinds.
            assert db.get(PipelineNode, bystander[1]).dataset_id == bystander[0]
            assert db.get(PipelineNode, bystander[2]).input_id == bystander[1]
        finally:
            for project_id in (doomed.id, untouched.id):
                db.delete(db.get(Project, project_id))
            db.commit()
