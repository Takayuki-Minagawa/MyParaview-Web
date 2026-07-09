"""Add external trame render-session records.

Revision ID: 0005
Revises: 0004
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "render_sessions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("dataset_id", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("remote_session_id", sa.String(), nullable=False),
        sa.Column("remote_ws_url", sa.Text(), nullable=False),
        sa.Column("access_token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_render_sessions_project_id"), "render_sessions", ["project_id"])
    op.create_index(op.f("ix_render_sessions_dataset_id"), "render_sessions", ["dataset_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_render_sessions_dataset_id"), table_name="render_sessions")
    op.drop_index(op.f("ix_render_sessions_project_id"), table_name="render_sessions")
    op.drop_table("render_sessions")
