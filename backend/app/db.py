"""Database engine, session, and schema bootstrap."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str):
    connect_args = (
        {"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {}
    )
    return create_engine(
        url,
        connect_args=connect_args,
        future=True,
        pool_pre_ping=not url.startswith("sqlite"),
    )


engine = _make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

_LEGACY_0001_TABLES = {
    "projects", "datasets", "pipelines", "pipeline_nodes", "jobs", "artifacts",
}


def init_db() -> None:
    settings.ensure_dirs()
    # Import models so they register on Base.metadata before migration checks.
    from . import models  # noqa: F401

    migrate_database(settings.database_url)


def _alembic_config(database_url: str) -> Config:
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


def migrate_database(database_url: str) -> None:
    """Upgrade a database to head, adopting the pre-Alembic M1 schema safely.

    Releases before migration support used ``metadata.create_all``. If all
    tables from revision 0001 already exist but ``alembic_version`` does not,
    stamp that known schema and continue. Partial schemas are rejected rather
    than being silently mis-versioned.
    """
    from . import models  # noqa: F401

    inspection_engine = _make_engine(database_url)
    try:
        existing = set(inspect(inspection_engine).get_table_names())
    finally:
        inspection_engine.dispose()

    config = _alembic_config(database_url)
    if existing and "alembic_version" not in existing:
        expected = _LEGACY_0001_TABLES
        if not expected.issubset(existing):
            missing = ", ".join(sorted(expected - existing))
            raise RuntimeError(f"cannot adopt partial legacy schema; missing tables: {missing}")
        command.stamp(config, "0001")
    command.upgrade(config, "head")


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
