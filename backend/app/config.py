"""Runtime configuration (env-overridable)."""

from __future__ import annotations

import os
import shlex
from pathlib import Path


class Settings:
    def __init__(self) -> None:
        # Root for the local object store and SQLite db. Overridable for tests.
        self.data_root = Path(os.environ.get("PVWEB_DATA_ROOT", ".pvweb-data")).resolve()
        self.database_url = os.environ.get(
            "PVWEB_DATABASE_URL", f"sqlite:///{self.data_root / 'pvweb.db'}"
        )
        self.object_store = os.environ.get("PVWEB_OBJECT_STORE", "local").lower()
        self.s3_bucket = os.environ.get("PVWEB_S3_BUCKET", "pvweb")
        self.s3_endpoint_url = os.environ.get("PVWEB_S3_ENDPOINT_URL") or None
        self.s3_region = os.environ.get("PVWEB_S3_REGION", "us-east-1")
        self.s3_cache_max_bytes = int(
            os.environ.get("PVWEB_S3_CACHE_MAX_BYTES", str(5 * 1024 * 1024 * 1024))
        )
        self.s3_cache_ttl_seconds = int(os.environ.get("PVWEB_S3_CACHE_TTL_SECONDS", "86400"))
        # Optional: redirect dataset/artifact downloads straight to presigned
        # S3 URLs instead of streaming through the API process.
        self.s3_presigned_downloads = os.environ.get(
            "PVWEB_S3_PRESIGNED_DOWNLOADS", ""
        ).strip().lower() in {"1", "true", "yes", "on"}
        # Authentication is fail-closed by default. Local development must opt
        # into the header-based identity provider explicitly.
        self.auth_mode = os.environ.get("PVWEB_AUTH_MODE", "oidc").lower()
        self.allow_insecure_dev_auth = os.environ.get(
            "PVWEB_ALLOW_INSECURE_DEV_AUTH", ""
        ).strip().lower() in {"1", "true", "yes", "on"}
        self.oidc_issuer = os.environ.get("PVWEB_OIDC_ISSUER") or None
        self.oidc_audience = os.environ.get("PVWEB_OIDC_AUDIENCE") or None
        self.oidc_jwks_url = os.environ.get("PVWEB_OIDC_JWKS_URL") or None
        self.bootstrap_admin_subjects = {
            subject.strip()
            for subject in os.environ.get("PVWEB_BOOTSTRAP_ADMIN_SUBS", "").split(",")
            if subject.strip()
        }
        self.worker_command = shlex.split(os.environ.get("PVWEB_PVPYTHON", ""))
        # Video export is opt-in, just like pvpython.  Keep this as one
        # executable name/path (rather than a shell fragment); worker.py
        # resolves it to an executable absolute path before passing it to the
        # isolated pvpython process.
        self.ffmpeg_executable = os.environ.get("PVWEB_FFMPEG", "").strip()
        self.worker_timeout_seconds = int(os.environ.get("PVWEB_WORKER_TIMEOUT", "900"))
        self.trame_broker_url = os.environ.get("PVWEB_TRAME_BROKER_URL") or None
        self.trame_broker_token = os.environ.get("PVWEB_TRAME_BROKER_TOKEN") or None
        configured_ws_hosts = os.environ.get("PVWEB_TRAME_ALLOWED_WS_HOSTS", "")
        self.trame_allowed_ws_hosts = {
            host.strip().lower() for host in configured_ws_hosts.split(",") if host.strip()
        }
        self.session_ttl_seconds = int(os.environ.get("PVWEB_SESSION_TTL", "3600"))
        # Upload guardrails (work_plan 8.3 security).
        self.max_upload_bytes = int(os.environ.get("PVWEB_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
        self.max_artifact_bytes = int(
            os.environ.get("PVWEB_MAX_ARTIFACT_BYTES", str(32 * 1024 * 1024))
        )
        self.audit_list_limit = int(os.environ.get("PVWEB_AUDIT_LIST_LIMIT", "500"))
        # How long one /jobs/stream SSE connection lives before the client must
        # reconnect. Tests shrink this so stream teardown does not stall runs.
        self.job_stream_max_seconds = int(
            os.environ.get("PVWEB_JOB_STREAM_MAX_SECONDS", "300")
        )
        self.cors_origins = [
            origin.strip()
            for origin in os.environ.get("PVWEB_CORS_ORIGINS", "http://localhost:5173").split(",")
            if origin.strip()
        ]
        # Extension allow-list; magic/header checks live in datasets router.
        self.allowed_extensions = {
            ".vtp", ".vti", ".vtu", ".vts", ".vtr", ".pvd", ".csv",
            ".cgns", ".exo", ".e", ".case", ".xdmf", ".xmf",
        }
        self.external_extensions = {".cgns", ".exo", ".e", ".case", ".xdmf", ".xmf"}
        self.external_bundle_extensions = self.external_extensions | {
            ".h5", ".hdf5", ".geo", ".scl", ".vec", ".dat", ".bin",
        }

    def ensure_dirs(self) -> None:
        self.data_root.mkdir(parents=True, exist_ok=True)
        (self.data_root / "objects").mkdir(parents=True, exist_ok=True)
        (self.data_root / "s3-cache").mkdir(parents=True, exist_ok=True)


settings = Settings()
