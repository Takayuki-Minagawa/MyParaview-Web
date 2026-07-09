"""Local or S3-compatible object storage selected through configuration.

A thin stand-in for S3-compatible storage (work_plan M1-A). Keeps a flat
namespace of opaque keys under ``<data_root>/objects``. Swapping this class for
a boto3/minio implementation later keeps the router/job code unchanged.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import BinaryIO

from .config import settings


class ObjectStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or settings.data_root / "objects")
        self.root.mkdir(parents=True, exist_ok=True)

    def new_key(self, suffix: str = "") -> str:
        return f"{uuid.uuid4().hex}{suffix}"

    def path_for(self, key: str) -> Path:
        # keys are opaque hex; reject traversal defensively
        safe = Path(key).name
        return self.root / safe

    def save_stream(self, key: str, stream: BinaryIO, *, max_bytes: int) -> int:
        """Persist a stream to ``key``, enforcing a byte ceiling. Returns size."""
        dest = self.path_for(key)
        written = 0
        with open(dest, "wb") as out:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise ValueError(f"upload exceeds max_bytes={max_bytes}")
                out.write(chunk)
        return written

    def save_bytes(self, key: str, data: bytes) -> int:
        self.path_for(key).write_bytes(data)
        return len(data)

    def open(self, key: str) -> BinaryIO:
        return open(self.path_for(key), "rb")

    def exists(self, key: str) -> bool:
        return self.path_for(key).is_file()

    def delete(self, key: str) -> None:
        self.path_for(key).unlink(missing_ok=True)

    def copy_in(self, key: str, src: Path) -> int:
        shutil.copyfile(src, self.path_for(key))
        return self.path_for(key).stat().st_size


class S3ObjectStore(ObjectStore):
    """S3/MinIO store with an immutable local read-through cache.

    Application code consumes local paths for VTK readers and ``FileResponse``.
    Opaque objects are immutable, so caching them by key is safe and keeps the
    storage contract compatible with the local implementation.
    """

    def __init__(self) -> None:
        try:
            import boto3
            from botocore.exceptions import ClientError
        except ImportError as exc:  # pragma: no cover - deployment guard
            raise RuntimeError("PVWEB_OBJECT_STORE=s3 requires boto3") from exc
        super().__init__(settings.data_root / "s3-cache")
        self.bucket = settings.s3_bucket
        self._client_error = ClientError
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
        )

    def path_for(self, key: str) -> Path:
        path = super().path_for(key)
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                self.client.download_file(self.bucket, Path(key).name, str(path))
            except self._client_error as exc:
                status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))
                if status == 404:
                    path.unlink(missing_ok=True)
                    return path
                raise
        return path

    def save_stream(self, key: str, stream: BinaryIO, *, max_bytes: int) -> int:
        target = super().path_for(key)
        written = 0
        with open(target, "wb") as output:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    output.close()
                    target.unlink(missing_ok=True)
                    raise ValueError(f"upload exceeds max_bytes={max_bytes}")
                output.write(chunk)
        self.client.upload_file(str(target), self.bucket, Path(key).name)
        return written

    def save_bytes(self, key: str, data: bytes) -> int:
        target = super().path_for(key)
        target.write_bytes(data)
        self.client.upload_file(str(target), self.bucket, Path(key).name)
        return len(data)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=Path(key).name)
            return True
        except self._client_error as exc:
            status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))
            if status == 404:
                return False
            raise

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=Path(key).name)
        super().path_for(key).unlink(missing_ok=True)

    def copy_in(self, key: str, src: Path) -> int:
        target = super().path_for(key)
        shutil.copyfile(src, target)
        self.client.upload_file(str(target), self.bucket, Path(key).name)
        return target.stat().st_size


def create_store() -> ObjectStore:
    if settings.object_store == "local":
        return ObjectStore()
    if settings.object_store == "s3":
        return S3ObjectStore()
    raise RuntimeError(f"unsupported PVWEB_OBJECT_STORE={settings.object_store!r}")


store = create_store()
