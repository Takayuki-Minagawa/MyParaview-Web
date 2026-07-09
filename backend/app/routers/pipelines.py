from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..db import get_db
from ..models import Dataset, Pipeline, PipelineNode, Project
from ..schemas import PipelineCreate, PipelineOut, PipelineUpdate, ViewState

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


def _replace_nodes(db: Session, pipeline: Pipeline, node_specs) -> None:
    # clearing the collection triggers delete-orphan; appending keeps the
    # in-memory relationship consistent so serialization sees the new nodes.
    pipeline.nodes.clear()
    db.flush()
    created: list[tuple] = []
    for spec in node_specs:
        params = dict(spec.params)
        if spec.node_type == "representation" and "view_state" in params:
            try:
                params["view_state"] = ViewState.model_validate(params["view_state"]).model_dump(
                    exclude_unset=True
                )
            except ValueError as exc:
                raise HTTPException(422, f"invalid representation view_state: {exc}") from exc
        # a node referencing a dataset must point at an existing dataset in the
        # same project (SQLite doesn't enforce FKs, so validate explicitly).
        if spec.dataset_id is not None:
            ds = db.get(Dataset, spec.dataset_id)
            if ds is None:
                raise HTTPException(422, f"dataset_id {spec.dataset_id!r} not found")
            if ds.project_id != pipeline.project_id:
                raise HTTPException(
                    422, f"dataset_id {spec.dataset_id!r} belongs to a different project"
                )
        node = PipelineNode(
            node_type=spec.node_type,
            name=spec.name,
            params=params,
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
def create_pipeline(
    payload: PipelineCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, payload.project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, payload.project_id, principal, "editor")
    pipeline = Pipeline(project_id=payload.project_id, name=payload.name)
    db.add(pipeline)
    db.flush()
    request.state.audit_project_id = payload.project_id
    request.state.audit_resource_type = "pipeline"
    request.state.audit_resource_id = pipeline.id
    _replace_nodes(db, pipeline, payload.nodes)
    db.commit()
    db.refresh(pipeline)
    return pipeline


@router.get("", response_model=list[PipelineOut])
def list_pipelines(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)
    stmt = (
        select(Pipeline)
        .where(Pipeline.project_id == project_id)
        .order_by(Pipeline.created_at.desc())
    )
    return list(db.scalars(stmt).unique())


@router.get("/{pipeline_id}", response_model=PipelineOut)
def get_pipeline(
    pipeline_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    require_project_role(db, pipeline.project_id, principal)
    return pipeline


@router.patch("/{pipeline_id}", response_model=PipelineOut)
def update_pipeline(
    pipeline_id: str,
    payload: PipelineUpdate,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    require_project_role(db, pipeline.project_id, principal, "editor")
    if payload.name is not None:
        pipeline.name = payload.name
    if payload.nodes is not None:
        _replace_nodes(db, pipeline, payload.nodes)
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return pipeline


@router.delete("/{pipeline_id}", status_code=204)
def delete_pipeline(
    pipeline_id: str,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    require_project_role(db, pipeline.project_id, principal, "editor")
    request.state.audit_project_id = pipeline.project_id
    request.state.audit_resource_type = "pipeline"
    request.state.audit_resource_id = pipeline.id
    db.delete(pipeline)
    db.commit()
