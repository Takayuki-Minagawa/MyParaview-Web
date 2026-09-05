"""Run the E2E API with an isolated database, local storage and dev auth."""
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

if __name__ == "__main__":
    # Release builds may inherit production DB/storage/queue settings. None of
    # those settings may influence the disposable E2E API.
    for key in list(os.environ):
        if key.startswith("PVWEB_"):
            del os.environ[key]
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    with TemporaryDirectory(prefix="pvweb-e2e-") as directory:
        os.environ.update(
            PVWEB_DATA_ROOT=directory,
            PVWEB_AUTH_MODE="dev",
            PVWEB_ALLOW_INSECURE_DEV_AUTH="1",
        )
        uvicorn.run("app.main:app", host="127.0.0.1", port=8000)
