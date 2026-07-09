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
            assert connection.execute(text("select version_num from alembic_version")).scalar() == "0005"
            assert "dataset_files" in inspect(engine).get_table_names()
            assert "project_members" in inspect(engine).get_table_names()
            assert "audit_events" in inspect(engine).get_table_names()
            assert "render_sessions" in inspect(engine).get_table_names()
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
            assert connection.execute(text("select version_num from alembic_version")).scalar() == "0005"
            assert connection.execute(text("select name from projects where id='legacy'")).scalar() == "kept"
            assert connection.execute(
                text("select role from project_members where project_id='legacy' and user_id='anonymous'")
            ).scalar() == "admin"
    finally:
        engine.dispose()
