"""Pydantic request/response models."""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    tags: list[str] = Field(default_factory=list)
    created_at: datetime


class DatasetTagsUpdate(BaseModel):
    tags: list[str]

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for tag in tags:
            value = tag.strip()
            if not value:
                continue
            if len(value) > 50:
                raise ValueError("dataset tags must be at most 50 characters")
            identity = value.casefold()
            if identity in seen:
                continue
            seen.add(identity)
            normalized.append(value)
        if len(normalized) > 20:
            raise ValueError("datasets may have at most 20 tags")
        return normalized


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
    color_map: str = Field(pattern="^(cool-to-warm|viridis|grayscale|plasma|turbo)$")
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


def _finite_number(params: dict[str, Any], name: str) -> float:
    value = params.get(name)
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


FilterName = Literal[
    "slice",
    "clip",
    "contour",
    "threshold",
    "cell_to_point",
    "resample",
    "decimate",
]
JobKind = Literal["convert", "filter", "export", "render", "stats", "movie"]


def _integer_value(value: Any, name: str) -> int:
    """Return an integer value without silently truncating fractions."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    if isinstance(value, float) and (
        not math.isfinite(value) or not value.is_integer()
    ):
        raise ValueError(f"{name} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must be an integer") from None


def validate_filter_params(params: dict[str, Any]) -> dict[str, Any]:
    """Validate parameters for all supported ParaView server filters.

    Shared by ad-hoc filter jobs and stored pipeline execution so both paths
    enforce the same contract. Returns normalized params.
    """
    operation = str(params.get("filter", "")).lower()
    if operation not in {
        "slice",
        "clip",
        "contour",
        "threshold",
        "cell_to_point",
        "resample",
        "decimate",
    }:
        raise ValueError(
            "filter must be slice, clip, contour, threshold, cell_to_point, "
            "resample, or decimate"
        )

    if operation == "cell_to_point":
        return {**params, "filter": operation}

    if operation == "resample":
        dimensions = params.get("dimensions")
        if not isinstance(dimensions, list) or len(dimensions) != 3:
            raise ValueError("dimensions must contain three integers")
        normalized_dimensions = [
            _integer_value(value, "dimensions values") for value in dimensions
        ]
        if any(value < 2 or value > 512 for value in normalized_dimensions):
            raise ValueError("dimensions values must be between 2 and 512")
        return {
            **params,
            "filter": operation,
            "dimensions": normalized_dimensions,
        }

    if operation == "decimate":
        target_reduction = _finite_number(params, "target_reduction")
        if not 0 <= target_reduction < 1:
            raise ValueError(
                "target_reduction must be greater than or equal to 0 and less than 1"
            )
        return {
            **params,
            "filter": operation,
            "target_reduction": target_reduction,
        }

    if operation in {"slice", "clip"}:
        for name in ("origin", "normal"):
            vector = params.get(name)
            if not isinstance(vector, list) or len(vector) != 3:
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
        if not any(float(value) != 0 for value in params["normal"]):
            raise ValueError("normal must be non-zero")
        return {**params, "filter": operation}

    if not str(params.get("array", "")).strip():
        raise ValueError("array is required")
    association = str(params.get("association", "POINTS")).upper()
    if association not in {"POINTS", "CELLS"}:
        raise ValueError("association must be POINTS or CELLS")
    if operation == "contour":
        _finite_number(params, "value")
    else:
        minimum = _finite_number(params, "minimum")
        maximum = _finite_number(params, "maximum")
        if minimum > maximum:
            raise ValueError("minimum must be less than or equal to maximum")
    return {**params, "filter": operation, "association": association}


def _integer_param(params: dict[str, Any], name: str, default: int) -> int:
    """Return an integer job parameter without silently truncating values."""
    return _integer_value(params.get(name, default), name)


def validate_render_params(params: dict[str, Any]) -> dict[str, Any]:
    width = _integer_param(params, "width", 1280)
    height = _integer_param(params, "height", 960)
    if not (16 <= width <= 4096 and 16 <= height <= 4096):
        raise ValueError("width and height must be between 16 and 4096")
    normalized: dict[str, Any] = {**params, "width": width, "height": height}
    array = params.get("array")
    if array is not None:
        if not str(array).strip():
            raise ValueError("array must not be empty")
        association = str(params.get("association", "POINTS")).upper()
        if association not in {"POINTS", "CELLS"}:
            raise ValueError("association must be POINTS or CELLS")
        normalized["association"] = association
    return normalized


def validate_stats_params(params: dict[str, Any]) -> dict[str, Any]:
    bins = _integer_param(params, "bins", 32)
    if not (1 <= bins <= 256):
        raise ValueError("bins must be between 1 and 256")
    return {**params, "bins": bins}


class JobCreate(BaseModel):
    project_id: str
    kind: JobKind
    target_id: str
    params: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_operation_params(self):
        if self.kind == "filter":
            self.params = validate_filter_params(self.params)
        elif self.kind in {"render", "movie"}:
            self.params = validate_render_params(self.params)
        elif self.kind == "stats":
            self.params = validate_stats_params(self.params)
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
    id: Optional[str] = None
    action: str
    params: dict[str, Any]
    reason: str
    requires_confirmation: bool = True
    status: str = "proposed"


class AssistProposalRecordOut(ORMModel):
    id: str
    project_id: str
    dataset_id: str
    actor_id: Optional[str] = None
    prompt: str
    action: str
    params: dict[str, Any]
    reason: str
    status: str
    applied_job_id: Optional[str] = None
    created_at: datetime
