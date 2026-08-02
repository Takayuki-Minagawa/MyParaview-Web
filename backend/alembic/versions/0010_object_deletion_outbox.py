"""Add a durable object-store deletion outbox.

Revision ID: 0010
Revises: 0009
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "object_deletion_outbox",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("object_key", sa.String(), nullable=False),
        # No FK by design: deletion intents must survive job/project cascades.
        sa.Column("job_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_object_deletion_outbox_job_id"),
        "object_deletion_outbox",
        ["job_id"],
    )
    op.create_index(
        op.f("ix_object_deletion_outbox_created_at"),
        "object_deletion_outbox",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_object_deletion_outbox_created_at"),
        table_name="object_deletion_outbox",
    )
    op.drop_index(
        op.f("ix_object_deletion_outbox_job_id"),
        table_name="object_deletion_outbox",
    )
    op.drop_table("object_deletion_outbox")
