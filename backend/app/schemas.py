"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime
import math
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- Project ---- #
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectOut(ORMModel):
    id: str
    name: str
    created_at: datetime


class ProjectMemberCreate(BaseModel):
    user_id: str = Field(min_length=1, max_length=255)
    role: str = Field(pattern="^(viewer|editor|admin)$")
    email: Optional[str] = None
    display_name: Optional[str] = None


class ProjectMemberOut(ORMModel):
    id: str
    project_id: str
    user_id: str
    role: str
    created_at: datetime


class AuditEventOut(ORMModel):
    id: str
    actor_id: Optional[str] = None
    project_id: Optional[str] = None
    action: str
    resource_type: str
    resource_id: Optional[str] = None
    status_code: int
    detail: Optional[dict[str, Any]] = None
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


class CollectionStepOut(BaseModel):
    index: int
    time: float
    parts: list[int]
    files: list[str]


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


class ScalarSelectionState(BaseModel):
    name: str = Field(min_length=1)
    association: str = Field(pattern="^(point|cell)$")


class CameraState(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    position: list[float] = Field(min_length=3, max_length=3)
    focal_point: list[float] = Field(min_length=3, max_length=3)
    view_up: list[float] = Field(min_length=3, max_length=3)
    parallel_scale: float = Field(gt=0)


class TableCoordinatesState(BaseModel):
    x: str = Field(min_length=1)
    y: str = Field(min_length=1)
    z: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_distinct_axes(self):
        if len({self.x, self.y, self.z}) != 3:
            raise ValueError("table coordinate columns must be distinct")
        return self


class ViewState(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    schema_version: int = Field(default=1, ge=1, le=1)
    representation: str = Field(pattern="^(surface|wireframe|points)$")
    color_by: Optional[ScalarSelectionState] = None
    color_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    opacity: float = Field(ge=0, le=1)
    color_map: str = Field(pattern="^(cool-to-warm|viridis|grayscale)$")
    legend_visible: bool
    camera: Optional[CameraState] = None
    table_coordinates: Optional[TableCoordinatesState] = None
    image_mode: Optional[str] = Field(default=None, pattern="^(slice|volume)$")
    slice_axis: Optional[str] = Field(default=None, pattern="^(X|Y|Z)$")
    slice_index: Optional[int] = None
    timestep_index: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_color_range(self):
        if self.color_range is not None and self.color_range[0] >= self.color_range[1]:
            raise ValueError("color_range minimum must be less than maximum")
        return self


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
    params: dict[str, Any] = Field(default_factory=dict)
    target_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class JobCreate(BaseModel):
    project_id: str
    kind: str = Field(pattern="^(convert|filter|export)$")
    target_id: str
    params: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_operation_params(self):
        if self.kind != "filter":
            return self
        operation = str(self.params.get("filter", "")).lower()
        if operation not in {"slice", "clip", "contour", "threshold"}:
            raise ValueError("filter must be slice, clip, contour, or threshold")

        def finite_number(name: str) -> float:
            value = self.params.get(name)
            try:
                converted = float(value)
            except (TypeError, ValueError, OverflowError):
                raise ValueError(f"{name} must be a finite number") from None
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(converted)
            ):
                raise ValueError(f"{name} must be a finite number")
            return converted

        if operation in {"slice", "clip"}:
            for name in ("origin", "normal"):
                vector = self.params.get(name)
                if (
                    not isinstance(vector, list)
                    or len(vector) != 3
                ):
                    raise ValueError(f"{name} must contain three finite numbers")
                try:
                    converted = [float(value) for value in vector]
                except (TypeError, ValueError, OverflowError):
                    raise ValueError(f"{name} must contain three finite numbers") from None
                if any(
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(number)
                    for value, number in zip(vector, converted)
                ):
                    raise ValueError(f"{name} must contain three finite numbers")
            if not any(float(value) != 0 for value in self.params["normal"]):
                raise ValueError("normal must be non-zero")
        else:
            if not str(self.params.get("array", "")).strip():
                raise ValueError("array is required")
            association = str(self.params.get("association", "POINTS")).upper()
            if association not in {"POINTS", "CELLS"}:
                raise ValueError("association must be POINTS or CELLS")
            if operation == "contour":
                finite_number("value")
            else:
                minimum = finite_number("minimum")
                maximum = finite_number("maximum")
                if minimum > maximum:
                    raise ValueError("minimum must be less than or equal to maximum")
        self.params = {**self.params, "filter": operation}
        if operation in {"contour", "threshold"}:
            self.params["association"] = association
        return self


# ---- Artifact ---- #
class ArtifactOut(ORMModel):
    id: str
    dataset_id: Optional[str] = None
    job_id: Optional[str] = None
    kind: str
    filename: str
    size_bytes: int
    content_type: str
    created_at: datetime


# ---- Interactive render session ---- #
class RenderSessionCreate(BaseModel):
    project_id: str
    dataset_id: str
    mode: str = Field(default="remote", pattern="^(remote|local)$")


class RenderSessionOut(ORMModel):
    id: str
    project_id: str
    dataset_id: str
    mode: str
    status: str
    expires_at: datetime
    created_at: datetime


class RenderSessionCreated(RenderSessionOut):
    websocket_path: str
    websocket_protocol: str


# ---- Safe assistant proposals (never execute directly) ---- #
class AssistProposalCreate(BaseModel):
    dataset_id: str
    prompt: str = Field(min_length=1, max_length=2000)


class AssistProposalOut(BaseModel):
    action: str
    params: dict[str, Any]
    reason: str
    requires_confirmation: bool = True
