"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- Project ---- #
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectOut(ORMModel):
    id: str
    name: str
    created_at: datetime


# ---- Dataset ---- #
class DatasetOut(ORMModel):
    id: str
    project_id: str
    filename: str
    ext: str
    size_bytes: int
    status: str
    error: Optional[str] = None
    dataset_type: Optional[str] = None
    num_points: Optional[int] = None
    num_cells: Optional[int] = None
    num_blocks: Optional[int] = None
    bounds: Optional[list[float]] = None
    timesteps: Optional[list[float]] = None
    arrays: Optional[list[dict[str, Any]]] = None
    extra: Optional[dict[str, Any]] = None
    created_at: datetime


# ---- Pipeline ---- #
class PipelineNodeCreate(BaseModel):
    node_type: str = Field(pattern="^(reader|filter|representation)$")
    name: str
    params: dict[str, Any] = {}
    # client-assigned temporary id used to express edges within a batch;
    # `input_id` references another node's `local_id`, remapped to real ids
    # on persist.
    local_id: Optional[str] = None
    input_id: Optional[str] = None
    dataset_id: Optional[str] = None


class PipelineNodeOut(ORMModel):
    id: str
    pipeline_id: str
    node_type: str
    name: str
    params: dict[str, Any]
    input_id: Optional[str] = None
    dataset_id: Optional[str] = None


class PipelineCreate(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    nodes: list[PipelineNodeCreate] = []


class PipelineUpdate(BaseModel):
    name: Optional[str] = None
    nodes: Optional[list[PipelineNodeCreate]] = None


class PipelineOut(ORMModel):
    id: str
    project_id: str
    name: str
    created_at: datetime
    nodes: list[PipelineNodeOut] = []


# ---- Job ---- #
class JobOut(ORMModel):
    id: str
    project_id: Optional[str] = None
    kind: str
    status: str
    progress: float
    log: str
    result: Optional[dict[str, Any]] = None
    target_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
