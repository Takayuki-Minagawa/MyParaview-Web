"""Runtime configuration (env-overridable)."""

from __future__ import annotations

import os
from pathlib import Path


class Settings:
    def __init__(self) -> None:
        # Root for the local object store and SQLite db. Overridable for tests.
        self.data_root = Path(os.environ.get("PVWEB_DATA_ROOT", ".pvweb-data")).resolve()
        self.database_url = os.environ.get(
            "PVWEB_DATABASE_URL", f"sqlite:///{self.data_root / 'pvweb.db'}"
        )
        # Upload guardrails (work_plan 8.3 security).
        self.max_upload_bytes = int(os.environ.get("PVWEB_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
        # Extension allow-list; magic/header checks live in datasets router.
        self.allowed_extensions = {
            ".vtp", ".vti", ".vtu", ".vts", ".vtr", ".pvd", ".csv",
        }

    def ensure_dirs(self) -> None:
        self.data_root.mkdir(parents=True, exist_ok=True)
        (self.data_root / "objects").mkdir(parents=True, exist_ok=True)


settings = Settings()
