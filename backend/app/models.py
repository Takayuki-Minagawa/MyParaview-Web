"""SQLAlchemy ORM models (work_plan 7.1 entity subset for M1).

Array/timestep detail is stored as JSON on Dataset rather than as separate
tables; this keeps the MVP schema small while preserving the same information
the ArrayInfo/TimeStep entities would hold. They can be normalized later.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import JSON, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    datasets: Mapped[list["Dataset"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    pipelines: Mapped[list["Pipeline"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Dataset(Base):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    ext: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    object_key: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, default="registered")  # registered|ingesting|ready|error
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # extracted metadata (populated by ingest job)
    dataset_type: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    num_points: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    num_cells: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    num_blocks: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    bounds: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    timesteps: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    arrays: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    extra: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(default=_now)

    project: Mapped[Project] = relationship(back_populates="datasets")


class Pipeline(Base):
    __tablename__ = "pipelines"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    project: Mapped[Project] = relationship(back_populates="pipelines")
    nodes: Mapped[list["PipelineNode"]] = relationship(
        back_populates="pipeline", cascade="all, delete-orphan"
    )


class PipelineNode(Base):
    __tablename__ = "pipeline_nodes"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("pipelines.id"), index=True)
    node_type: Mapped[str] = mapped_column(String, nullable=False)  # reader|filter|representation
    name: Mapped[str] = mapped_column(String, nullable=False)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    input_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("pipeline_nodes.id"), nullable=True
    )
    dataset_id: Mapped[Optional[str]] = mapped_column(ForeignKey("datasets.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    pipeline: Mapped[Pipeline] = relationship(back_populates="nodes")


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[Optional[str]] = mapped_column(ForeignKey("projects.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # ingest|filter|convert|render|export
    status: Mapped[str] = mapped_column(String, default="queued")  # queued|running|succeeded|failed|canceled
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    log: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    target_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # e.g. dataset id
    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)


class Artifact(Base):
    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    dataset_id: Mapped[Optional[str]] = mapped_column(ForeignKey("datasets.id"), nullable=True)
    job_id: Mapped[Optional[str]] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # converted_vtp|screenshot|...
    object_key: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, default="application/octet-stream")
    created_at: Mapped[datetime] = mapped_column(default=_now)
