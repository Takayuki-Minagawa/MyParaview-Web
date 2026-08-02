"""Exercise the 0008 -> 0009 tag migration and PostgreSQL tag query path."""

from __future__ import annotations

from datetime import datetime, timezone

from alembic import command
from sqlalchemy import create_engine, exists, func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import _alembic_config
from app.models import Dataset

PROJECT_ID = "ci-tags-project"
DATASET_ID = "ci-tags-dataset"


def main() -> None:
    engine = create_engine(settings.database_url)
    if engine.dialect.name != "postgresql":
        raise RuntimeError("this verification requires PostgreSQL")

    config = _alembic_config(settings.database_url)
    command.downgrade(config, "0008")
    try:
        with engine.begin() as connection:
            connection.execute(
                text("delete from datasets where id = :id"), {"id": DATASET_ID}
            )
            connection.execute(
                text("delete from project_members where project_id = :id"),
                {"id": PROJECT_ID},
            )
            connection.execute(
                text("delete from projects where id = :id"), {"id": PROJECT_ID}
            )
            connection.execute(
                text(
                    "insert into projects (id, name, created_at) "
                    "values (:id, :name, :created_at)"
                ),
                {
                    "id": PROJECT_ID,
                    "name": "PostgreSQL tag migration CI",
                    "created_at": datetime.now(timezone.utc),
                },
            )
            connection.execute(
                text(
                    "insert into datasets "
                    "(id, project_id, filename, ext, size_bytes, object_key, status, created_at) "
                    "values (:id, :project_id, :filename, :ext, 0, :object_key, "
                    "'ready', :created_at)"
                ),
                {
                    "id": DATASET_ID,
                    "project_id": PROJECT_ID,
                    "filename": "legacy.vtp",
                    "ext": ".vtp",
                    "object_key": "ci/legacy.vtp",
                    "created_at": datetime.now(timezone.utc),
                },
            )

        command.upgrade(config, "head")
        with Session(engine) as session:
            dataset = session.get(Dataset, DATASET_ID)
            assert dataset is not None
            assert dataset.tags == []
            dataset.tags = ["Thermal", "case-a"]
            session.commit()

            tag_values = func.json_array_elements_text(Dataset.tags).table_valued(
                "value"
            ).render_derived(name="dataset_tags")
            statement = select(Dataset.id).where(
                Dataset.project_id == PROJECT_ID,
                exists(
                    select(1).select_from(tag_values).where(
                        func.lower(tag_values.c.value) == "thermal"
                    )
                ),
            )
            assert session.scalar(statement) == DATASET_ID

        with engine.connect() as connection:
            assert connection.execute(
                text("select version_num from alembic_version")
            ).scalar_one() == "0009"
    finally:
        # Leave the database at head even if an assertion above fails, making
        # local reruns and CI diagnostics predictable.
        command.upgrade(config, "head")
        engine.dispose()


if __name__ == "__main__":
    main()
