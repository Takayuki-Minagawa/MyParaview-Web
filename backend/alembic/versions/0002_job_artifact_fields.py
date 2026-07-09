"""Add job parameters and artifact metadata.

Revision ID: 0002
Revises: 0001
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("params", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "artifacts",
        sa.Column("filename", sa.String(), nullable=False, server_default="artifact"),
    )
    op.add_column(
        "artifacts",
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("artifacts", "size_bytes")
    op.drop_column("artifacts", "filename")
    op.drop_column("jobs", "params")
