"""Local or S3-compatible object storage selected through configuration.

A thin stand-in for S3-compatible storage (work_plan M1-A). Keeps a flat
namespace of opaque keys under ``<data_root>/objects``. Swapping this class for
a boto3/minio implementation later keeps the router/job code unchanged.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

from .config import settings


class ObjectStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or settings.data_root / "objects")
        self.root.mkdir(parents=True, exist_ok=True)
        self._lease_lock = threading.Lock()
        self._leases: dict[str, int] = {}
        self._pending_delete: set[str] = set()

    def reset_after_fork(self) -> None:
        """Replace process-local synchronization inherited by a forked worker."""

        self._lease_lock = threading.Lock()
        self._leases = {}
        self._pending_delete = set()

    def new_key(self, suffix: str = "") -> str:
        return f"{uuid.uuid4().hex}{suffix}"

    def path_for(self, key: str) -> Path:
        # keys are opaque hex; reject traversal defensively
        safe = Path(key).name
        return self.root / safe

    def acquire_path(self, key: str) -> Path:
        """Return a local path protected from cache eviction until release."""
        safe = Path(key).name
        with self._lease_lock:
            self._leases[safe] = self._leases.get(safe, 0) + 1
        try:
            return self.path_for(safe)
        except Exception:
            self.release_path(safe)
            raise

    def release_path(self, key: str) -> None:
        """Release a path and finish a deferred local deletion if necessary."""
        safe = Path(key).name
        with self._lease_lock:
            remaining = self._leases.get(safe, 0) - 1
            if remaining > 0:
                self._leases[safe] = remaining
            else:
                self._leases.pop(safe, None)
                if safe in self._pending_delete:
                    self._pending_delete.remove(safe)
                    (self.root / safe).unlink(missing_ok=True)

    def _delete_local_when_unleased(self, key: str) -> bool:
        """Delete a local object, returning whether removal is complete."""

        safe = Path(key).name
        with self._lease_lock:
            if self._leases.get(safe, 0) > 0:
                self._pending_delete.add(safe)
                return False
            (self.root / safe).unlink(missing_ok=True)
            return True

    @contextmanager
    def local_path(self, key: str) -> Iterator[Path]:
        path = self.acquire_path(key)
        try:
            yield path
        finally:
            self.release_path(key)

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

    def delete(self, key: str) -> bool:
        return self._delete_local_when_unleased(key)

    def copy_in(self, key: str, src: Path) -> int:
        shutil.copyfile(src, self.path_for(key))
        return self.path_for(key).stat().st_size

    def presigned_url(self, key: str, *, filename: str, expires_seconds: int = 300) -> str | None:
        """Return a direct-download URL when the backend supports one."""
        return None


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
        # Hidden parts are only live within this in-process store instance;
        # leftovers here mean the previous process died before its finally block.
        for stale_part in self.root.glob(".*.part"):
            stale_part.unlink(missing_ok=True)
        self.bucket = settings.s3_bucket
        self._client_error = ClientError
        self.cache_max_bytes = max(0, settings.s3_cache_max_bytes)
        self.cache_ttl_seconds = max(0, settings.s3_cache_ttl_seconds)
        self._cache_lock = threading.Lock()
        self._needs_eviction = False
        # Fixed stripes avoid both duplicate downloads and an unbounded lock map.
        self._key_locks = tuple(threading.Lock() for _ in range(64))
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
        )

    def reset_after_fork(self) -> None:
        """Drop inherited boto3 pools and locks before a workhorse uses S3."""

        inherited_client = self.client
        try:
            inherited_client.close()
        except Exception:  # noqa: BLE001 - replacement must still complete
            pass
        finally:
            super().reset_after_fork()
            self._cache_lock = threading.Lock()
            self._needs_eviction = False
            self._key_locks = tuple(threading.Lock() for _ in range(64))
            import boto3

            self.client = boto3.client(
                "s3",
                endpoint_url=settings.s3_endpoint_url,
                region_name=settings.s3_region,
            )

    def _key_lock(self, key: str) -> threading.Lock:
        return self._key_locks[hash(Path(key).name) % len(self._key_locks)]

    def release_path(self, key: str) -> None:
        super().release_path(key)
        # Leases may temporarily allow the cache to exceed its limit. Converge
        # when the consumer finishes, but do not scan the whole cache on every
        # normal FileResponse/timestep frame.
        with self._cache_lock:
            needs_eviction = self._needs_eviction
        if needs_eviction:
            self._evict_cache()

    def _evict_path(self, path: Path) -> int:
        """Delete one unleased cache file and return the removed byte count."""
        with self._key_lock(path.name):
            with self._lease_lock:
                if self._leases.get(path.name, 0) > 0:
                    return 0
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                return 0
            path.unlink(missing_ok=True)
            return size

    def _evict_cache(self, *, exclude: Path | None = None) -> None:
        with self._cache_lock:
            now = time.time()
            deferred = False
            cached: list[tuple[Path, os.stat_result]] = []
            for path in self.root.iterdir():
                if not path.is_file() or path.name.startswith("."):
                    continue
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                if (
                    path != exclude
                    and self.cache_ttl_seconds > 0
                    and now - stat.st_mtime > self.cache_ttl_seconds
                ):
                    if self._evict_path(path):
                        continue
                    deferred = True
                    try:
                        stat = path.stat()
                    except FileNotFoundError:
                        continue
                cached.append((path, stat))
            total = sum(stat.st_size for _, stat in cached)
            if self.cache_max_bytes <= 0:
                self._needs_eviction = deferred
                return
            for path, _stat in sorted(cached, key=lambda item: item[1].st_mtime):
                if total <= self.cache_max_bytes:
                    break
                if path == exclude:
                    continue
                total -= self._evict_path(path)
            self._needs_eviction = deferred or total > self.cache_max_bytes

    def path_for(self, key: str) -> Path:
        path = super().path_for(key)
        with self._key_lock(key):
            if path.is_file():
                os.utime(path, None)
                return path
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
            try:
                self.client.download_file(self.bucket, Path(key).name, str(temporary))
                os.replace(temporary, path)
            except self._client_error as exc:
                status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))
                if status == 404:
                    temporary.unlink(missing_ok=True)
                    return path
                raise
            finally:
                temporary.unlink(missing_ok=True)
        self._evict_cache(exclude=path)
        return path

    def save_stream(self, key: str, stream: BinaryIO, *, max_bytes: int) -> int:
        target = super().path_for(key)
        written = 0
        with self._key_lock(key):
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
            try:
                with open(temporary, "wb") as output:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > max_bytes:
                            raise ValueError(f"upload exceeds max_bytes={max_bytes}")
                        output.write(chunk)
                self.client.upload_file(str(temporary), self.bucket, Path(key).name)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        self._evict_cache(exclude=target)
        return written

    def save_bytes(self, key: str, data: bytes) -> int:
        target = super().path_for(key)
        with self._key_lock(key):
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
            try:
                temporary.write_bytes(data)
                self.client.upload_file(str(temporary), self.bucket, Path(key).name)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        self._evict_cache(exclude=target)
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

    def delete(self, key: str) -> bool:
        with self._key_lock(key):
            self.client.delete_object(Bucket=self.bucket, Key=Path(key).name)
            self._delete_local_when_unleased(key)
            # The S3 object is authoritative. A leased local cache copy is
            # process-local and is removed automatically when its lease ends.
            return True

    def copy_in(self, key: str, src: Path) -> int:
        target = super().path_for(key)
        with self._key_lock(key):
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
            try:
                shutil.copyfile(src, temporary)
                self.client.upload_file(str(temporary), self.bucket, Path(key).name)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        self._evict_cache(exclude=target)
        return target.stat().st_size

    def presigned_url(self, key: str, *, filename: str, expires_seconds: int = 300) -> str | None:
        if not settings.s3_presigned_downloads:
            return None
        return self.client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": Path(key).name,
                "ResponseContentDisposition": f'attachment; filename="{filename}"',
            },
            ExpiresIn=expires_seconds,
        )


def create_store() -> ObjectStore:
    if settings.object_store == "local":
        return ObjectStore()
    if settings.object_store == "s3":
        return S3ObjectStore()
    raise RuntimeError(f"unsupported PVWEB_OBJECT_STORE={settings.object_store!r}")


store = create_store()
