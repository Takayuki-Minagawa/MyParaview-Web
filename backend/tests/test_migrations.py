from __future__ import annotations

from alembic import command
from sqlalchemy import create_engine, inspect, text

from app.db import _alembic_config, migrate_database


def test_fresh_database_upgrades_to_head(tmp_path):
    path = tmp_path / "fresh.db"
    url = f"sqlite:///{path}"
    migrate_database(url)
    engine = create_engine(url)
    try:
        assert "projects" in inspect(engine).get_table_names()
        with engine.connect() as connection:
            assert connection.execute(text("select version_num from alembic_version")).scalar() == "0007"
            assert "dataset_files" in inspect(engine).get_table_names()
            assert "project_members" in inspect(engine).get_table_names()
            assert "audit_events" in inspect(engine).get_table_names()
            assert "render_sessions" in inspect(engine).get_table_names()
            input_fk = next(
                fk
                for fk in inspect(engine).get_foreign_keys("pipeline_nodes")
                if fk["constrained_columns"] == ["input_id"]
            )
            assert input_fk["options"].get("ondelete") == "SET NULL"
            dataset_fk = next(
                fk
                for fk in inspect(engine).get_foreign_keys("pipeline_nodes")
                if fk["constrained_columns"] == ["dataset_id"]
            )
            assert dataset_fk["options"].get("ondelete") == "SET NULL"
    finally:
        engine.dispose()


def test_legacy_create_all_database_is_adopted(tmp_path):
    path = tmp_path / "legacy.db"
    url = f"sqlite:///{path}"
    # Simulate the pre-Alembic M1 schema: revision-0001 tables, no version row.
    command.upgrade(_alembic_config(url), "0001")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text("drop table alembic_version"))
        connection.execute(
            text("insert into projects (id, name, created_at) values ('legacy', 'kept', '2026-01-01')")
        )
    engine.dispose()

    migrate_database(url)

    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("select version_num from alembic_version")).scalar() == "0007"
            assert connection.execute(text("select name from projects where id='legacy'")).scalar() == "kept"
            assert connection.execute(
                text("select role from project_members where project_id='legacy' and user_id='anonymous'")
            ).scalar() == "admin"
    finally:
        engine.dispose()


def test_pipeline_dataset_fk_roundtrip_preserves_indexes_and_other_fks(tmp_path):
    path = tmp_path / "pipeline-fk.db"
    url = f"sqlite:///{path}"
    migrate_database(url)
    config = _alembic_config(url)
    engine = create_engine(url)

    def schema_state():
        inspector = inspect(engine)
        foreign_keys = {
            tuple(fk["constrained_columns"]): (
                fk["referred_table"],
                tuple(fk["referred_columns"]),
                fk["options"].get("ondelete"),
            )
            for fk in inspector.get_foreign_keys("pipeline_nodes")
        }
        indexes = {
            (index["name"], tuple(index["column_names"]))
            for index in inspector.get_indexes("pipeline_nodes")
        }
        return foreign_keys, indexes

    try:
        upgraded_fks, upgraded_indexes = schema_state()
        assert upgraded_fks[("input_id",)] == ("pipeline_nodes", ("id",), "SET NULL")
        assert upgraded_fks[("dataset_id",)] == ("datasets", ("id",), "SET NULL")
        assert upgraded_fks[("pipeline_id",)] == ("pipelines", ("id",), None)

        command.downgrade(config, "-1")
        downgraded_fks, downgraded_indexes = schema_state()
        assert downgraded_fks[("input_id",)] == ("pipeline_nodes", ("id",), "SET NULL")
        assert downgraded_fks[("dataset_id",)] == ("datasets", ("id",), None)
        assert downgraded_fks[("pipeline_id",)] == ("pipelines", ("id",), None)
        assert downgraded_indexes == upgraded_indexes

        command.upgrade(config, "head")
        roundtripped_fks, roundtripped_indexes = schema_state()
        assert roundtripped_fks == upgraded_fks
        assert roundtripped_indexes == upgraded_indexes
    finally:
        engine.dispose()
