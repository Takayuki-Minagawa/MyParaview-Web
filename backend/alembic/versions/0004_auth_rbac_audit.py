"""Add users, project memberships, and audit events.

Revision ID: 0004
Revises: 0003
"""

from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "project_members",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "user_id"),
    )
    op.create_index(op.f("ix_project_members_project_id"), "project_members", ["project_id"])
    op.create_index(op.f("ix_project_members_user_id"), "project_members", ["user_id"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=True),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("resource_type", sa.String(), nullable=False),
        sa.Column("resource_id", sa.String(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_audit_events_actor_id"), "audit_events", ["actor_id"])
    op.create_index(op.f("ix_audit_events_project_id"), "audit_events", ["project_id"])
    op.create_index(op.f("ix_audit_events_created_at"), "audit_events", ["created_at"])

    # Preserve pre-auth local installations: the disabled-auth principal keeps
    # admin access to every existing project after the migration.
    users = sa.table(
        "users",
        sa.column("id", sa.String()),
        sa.column("display_name", sa.String()),
        sa.column("created_at", sa.DateTime()),
    )
    op.bulk_insert(
        users,
        [{"id": "anonymous", "display_name": "Local user", "created_at": datetime.now(timezone.utc)}],
        multiinsert=False,
    )
    # Project ids are already globally unique and therefore also form safe,
    # deterministic ids for these one-time legacy membership rows. INSERT FROM
    # SELECT works in both online migrations and Alembic's offline SQL mode.
    op.execute(
        "INSERT INTO project_members (id, project_id, user_id, role, created_at) "
        "SELECT id, id, 'anonymous', 'admin', CURRENT_TIMESTAMP FROM projects"
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_audit_events_created_at"), table_name="audit_events")
    op.drop_index(op.f("ix_audit_events_project_id"), table_name="audit_events")
    op.drop_index(op.f("ix_audit_events_actor_id"), table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index(op.f("ix_project_members_user_id"), table_name="project_members")
    op.drop_index(op.f("ix_project_members_project_id"), table_name="project_members")
    op.drop_table("project_members")
    op.drop_table("users")
