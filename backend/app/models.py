"""SQLAlchemy ORM models (work_plan 7.1 entity subset for M1).

Array/timestep detail is stored as JSON on Dataset rather than as separate
tables; this keeps the MVP schema small while preserving the same information
the ArrayInfo/TimeStep entities would hold. They can be normalized later.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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
    members: Mapped[list["ProjectMember"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    jobs: Mapped[list["Job"]] = relationship(cascade="all, delete-orphan")
    render_sessions: Mapped[list["RenderSession"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    display_name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String, nullable=False)  # viewer|editor|admin
    created_at: Mapped[datetime] = mapped_column(default=_now)

    project: Mapped[Project] = relationship(back_populates="members")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    actor_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    project_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    action: Mapped[str] = mapped_column(String, nullable=False)
    resource_type: Mapped[str] = mapped_column(String, nullable=False)
    resource_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


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
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(default=_now)

    project: Mapped[Project] = relationship(back_populates="datasets")
    files: Mapped[list["DatasetFile"]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan"
    )
    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan"
    )
    render_sessions: Mapped[list["RenderSession"]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan"
    )


class DatasetFile(Base):
    """One member of a multi-file dataset bundle such as a PVD collection."""

    __tablename__ = "dataset_files"
    __table_args__ = (UniqueConstraint("dataset_id", "relative_path"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    relative_path: Mapped[str] = mapped_column(String, nullable=False)
    object_key: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    dataset: Mapped[Dataset] = relationship(back_populates="files")


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
        ForeignKey("pipeline_nodes.id", ondelete="SET NULL"), nullable=True
    )
    dataset_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True
    )
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
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    target_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # e.g. dataset id
    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)
    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )


class Artifact(Base):
    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    dataset_id: Mapped[Optional[str]] = mapped_column(ForeignKey("datasets.id"), nullable=True)
    job_id: Mapped[Optional[str]] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # converted_vtp|screenshot|...
    filename: Mapped[str] = mapped_column(String, nullable=False, default="artifact")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    object_key: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, default="application/octet-stream")
    created_at: Mapped[datetime] = mapped_column(default=_now)
    dataset: Mapped[Optional[Dataset]] = relationship(back_populates="artifacts")
    job: Mapped[Optional[Job]] = relationship(back_populates="artifacts")


class AssistProposal(Base):
    """A persisted assistant proposal awaiting explicit user confirmation."""

    __tablename__ = "assist_proposals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    actor_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)  # filter_job|view_change|none
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="proposed")  # proposed|applied|dismissed
    applied_job_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


class RenderSession(Base):
    __tablename__ = "render_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    mode: Mapped[str] = mapped_column(String, nullable=False)  # remote|local
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    remote_session_id: Mapped[str] = mapped_column(String, nullable=False)
    remote_ws_url: Mapped[str] = mapped_column(Text, nullable=False)
    access_token_hash: Mapped[str] = mapped_column(String, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    project: Mapped[Project] = relationship(back_populates="render_sessions")
    dataset: Mapped[Dataset] = relationship(back_populates="render_sessions")
