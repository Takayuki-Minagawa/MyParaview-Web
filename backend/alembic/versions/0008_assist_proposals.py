"""Persist assistant proposals for confirm-to-apply workflows.

Revision ID: 0008
Revises: 0007
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "assist_proposals",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("dataset_id", sa.String(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("applied_job_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_assist_proposals_project_id"), "assist_proposals", ["project_id"])
    op.create_index(op.f("ix_assist_proposals_dataset_id"), "assist_proposals", ["dataset_id"])
    op.create_index(op.f("ix_assist_proposals_created_at"), "assist_proposals", ["created_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_assist_proposals_created_at"), table_name="assist_proposals")
    op.drop_index(op.f("ix_assist_proposals_dataset_id"), table_name="assist_proposals")
    op.drop_index(op.f("ix_assist_proposals_project_id"), table_name="assist_proposals")
    op.drop_table("assist_proposals")
