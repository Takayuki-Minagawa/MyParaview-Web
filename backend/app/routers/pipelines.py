from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Pipeline, PipelineNode, Project
from ..schemas import PipelineCreate, PipelineOut, PipelineUpdate

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


def _replace_nodes(db: Session, pipeline: Pipeline, node_specs) -> None:
    # clearing the collection triggers delete-orphan; appending keeps the
    # in-memory relationship consistent so serialization sees the new nodes.
    pipeline.nodes.clear()
    db.flush()
    created: list[tuple] = []
    for spec in node_specs:
        node = PipelineNode(
            node_type=spec.node_type,
            name=spec.name,
            params=spec.params,
            dataset_id=spec.dataset_id,
        )
        pipeline.nodes.append(node)
        created.append((spec, node))
    db.flush()  # assign real ids before wiring edges

    # map client-provided local_id -> persisted node id, then resolve input_id
    local_to_id = {spec.local_id: node.id for spec, node in created if spec.local_id}
    for spec, node in created:
        if spec.input_id is None:
            continue
        resolved = local_to_id.get(spec.input_id)
        if resolved is None:
            raise HTTPException(
                422, f"input_id {spec.input_id!r} does not reference a node local_id in this request"
            )
        node.input_id = resolved


@router.post("", response_model=PipelineOut, status_code=201)
def create_pipeline(payload: PipelineCreate, db: Session = Depends(get_db)):
    if db.get(Project, payload.project_id) is None:
        raise HTTPException(404, "project not found")
    pipeline = Pipeline(project_id=payload.project_id, name=payload.name)
    db.add(pipeline)
    db.flush()
    _replace_nodes(db, pipeline, payload.nodes)
    db.commit()
    db.refresh(pipeline)
    return pipeline


@router.get("/{pipeline_id}", response_model=PipelineOut)
def get_pipeline(pipeline_id: str, db: Session = Depends(get_db)):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    return pipeline


@router.patch("/{pipeline_id}", response_model=PipelineOut)
def update_pipeline(pipeline_id: str, payload: PipelineUpdate, db: Session = Depends(get_db)):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    if payload.name is not None:
        pipeline.name = payload.name
    if payload.nodes is not None:
        _replace_nodes(db, pipeline, payload.nodes)
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return pipeline


@router.delete("/{pipeline_id}", status_code=204)
def delete_pipeline(pipeline_id: str, db: Session = Depends(get_db)):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    db.delete(pipeline)
    db.commit()
