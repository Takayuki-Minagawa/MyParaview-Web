"""Set pipeline dataset references to null when a dataset is deleted.

Revision ID: 0007
Revises: 0006
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SQLITE_FK_NAME = "fk_pipeline_nodes_dataset_id_datasets"
_NAMING_CONVENTION = {
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
}


def _replace_dataset_fk(*, ondelete: str | None) -> None:
    dialect = op.get_context().dialect.name
    if dialect == "postgresql":
        op.drop_constraint(
            "pipeline_nodes_dataset_id_fkey",
            "pipeline_nodes",
            type_="foreignkey",
        )
        op.create_foreign_key(
            "pipeline_nodes_dataset_id_fkey",
            "pipeline_nodes",
            "datasets",
            ["dataset_id"],
            ["id"],
            ondelete=ondelete,
        )
        return
    with op.batch_alter_table(
        "pipeline_nodes",
        naming_convention=_NAMING_CONVENTION,
    ) as batch_op:
        batch_op.drop_constraint(_SQLITE_FK_NAME, type_="foreignkey")
        batch_op.create_foreign_key(
            _SQLITE_FK_NAME,
            "datasets",
            ["dataset_id"],
            ["id"],
            ondelete=ondelete,
        )


def upgrade() -> None:
    _replace_dataset_fk(ondelete="SET NULL")


def downgrade() -> None:
    _replace_dataset_fk(ondelete=None)
