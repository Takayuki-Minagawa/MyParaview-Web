"""Add searchable tags to datasets.

Revision ID: 0009
Revises: 0008
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The database default backfills existing rows and also keeps direct SQL
    # inserts aligned with the application's empty-list default.
    op.add_column(
        "datasets",
        sa.Column("tags", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("datasets", "tags")
