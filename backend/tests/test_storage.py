from __future__ import annotations

import asyncio
import io
import threading
import time

import boto3
from botocore.exceptions import ClientError

from app.responses import LeasedFileResponse
from app.storage import ObjectStore, S3ObjectStore


class FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.download_count = 0
        self.download_delay = 0.0
        self.upload_delay = 0.0
        self.close_count = 0

    def close(self) -> None:
        self.close_count += 1

    def upload_file(self, filename: str, bucket: str, key: str) -> None:
        if self.upload_delay:
            time.sleep(self.upload_delay)
        with open(filename, "rb") as source:
            self.objects[(bucket, key)] = source.read()

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        if (bucket, key) not in self.objects:
            raise ClientError(
                {"Error": {"Code": "404"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
                "GetObject",
            )
        self.download_count += 1
        if self.download_delay:
            time.sleep(self.download_delay)
        with open(filename, "wb") as target:
            target.write(self.objects[(bucket, key)])

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        return {"ContentLength": len(self.objects[(Bucket, Key)])}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        self.objects.pop((Bucket, Key), None)


def test_leased_file_response_releases_on_normal_range_errors_and_disconnect(tmp_path):
    storage = ObjectStore(tmp_path)
    key = storage.new_key(".bin")
    storage.save_bytes(key, b"payload")

    async def invoke(headers=(), *, disconnect=False):
        path = storage.acquire_path(key)
        response = LeasedFileResponse(path, store=storage, object_key=key)
        messages = []

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            if disconnect and message["type"] == "http.response.body":
                raise OSError("client disconnected")
            messages.append(message)

        scope = {
            "type": "http",
            "method": "GET",
            "headers": list(headers),
        }
        try:
            await response(scope, receive, send)
        except OSError:
            if not disconnect:
                raise
        return messages

    normal = asyncio.run(invoke())
    assert normal[0]["status"] == 200
    assert storage._leases == {}

    malformed = asyncio.run(invoke([(b"range", b"wat")]))
    assert malformed[0]["status"] == 400
    assert storage._leases == {}

    unsatisfiable = asyncio.run(invoke([(b"range", b"bytes=999-1000")]))
    assert unsatisfiable[0]["status"] == 416
    assert storage._leases == {}

    asyncio.run(invoke(disconnect=True))
    assert storage._leases == {}


def test_s3_store_stream_cache_and_delete(monkeypatch):
    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    storage = S3ObjectStore()
    key = storage.new_key(".bin")

    assert storage.save_stream(key, io.BytesIO(b"payload"), max_bytes=16) == 7
    assert client.objects[(storage.bucket, key)] == b"payload"
    storage.path_for(key).unlink()
    assert storage.path_for(key).read_bytes() == b"payload"
    assert storage.exists(key)

    assert storage.delete(key) is True
    assert (storage.bucket, key) not in client.objects
    assert not storage.root.joinpath(key).exists()


def test_s3_store_replaces_inherited_client_and_process_local_state(monkeypatch):
    inherited = FakeS3Client()
    replacement = FakeS3Client()
    clients = iter((inherited, replacement))
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: next(clients))
    storage = S3ObjectStore()
    old_lease_lock = storage._lease_lock
    old_cache_lock = storage._cache_lock
    old_key_locks = storage._key_locks
    storage._leases["leased"] = 1
    storage._pending_delete.add("leased")
    storage._needs_eviction = True

    storage.reset_after_fork()

    assert inherited.close_count == 1
    assert storage.client is replacement
    assert storage._lease_lock is not old_lease_lock
    assert storage._cache_lock is not old_cache_lock
    assert storage._key_locks is not old_key_locks
    assert storage._leases == {}
    assert storage._pending_delete == set()
    assert storage._needs_eviction is False


def test_s3_store_removes_crash_leftover_parts_on_start(monkeypatch):
    from app.config import settings

    cache_root = settings.data_root / "s3-cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    stale = cache_root / ".dead-object.crash.part"
    stale.write_bytes(b"partial")
    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)

    S3ObjectStore()
    assert not stale.exists()


def test_s3_missing_object_returns_nonexistent_cache_path(monkeypatch):
    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    storage = S3ObjectStore()
    key = storage.new_key(".vtp")
    path = storage.path_for(key)
    assert not path.exists()


def test_s3_concurrent_cache_fill_is_atomic_and_downloads_once(monkeypatch):
    client = FakeS3Client()
    client.download_delay = 0.05
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    storage = S3ObjectStore()
    key = storage.new_key(".bin")
    payload = b"complete-payload" * 100
    client.objects[(storage.bucket, key)] = payload

    results: list[bytes] = []
    threads = [threading.Thread(target=lambda: results.append(storage.path_for(key).read_bytes())) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results == [payload] * 4
    assert client.download_count == 1
    assert not list(storage.root.glob(".*.part"))


def test_s3_cache_evicts_oldest_file_over_size_limit(monkeypatch):
    from app.config import settings

    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 10)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 3600)
    storage = S3ObjectStore()
    first = storage.new_key(".bin")
    second = storage.new_key(".bin")
    storage.save_bytes(first, b"1234567")
    time.sleep(0.01)
    storage.save_bytes(second, b"7654321")

    assert not storage.root.joinpath(first).exists()
    assert storage.root.joinpath(second).read_bytes() == b"7654321"
    assert (storage.bucket, first) in client.objects


def test_s3_concurrent_uploads_cannot_evict_inflight_temporary_files(monkeypatch):
    from app.config import settings

    client = FakeS3Client()
    client.upload_delay = 0.05
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 4)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 3600)
    storage = S3ObjectStore()
    keys = [storage.new_key(".bin"), storage.new_key(".bin")]
    failures: list[Exception] = []

    def save(key: str, payload: bytes) -> None:
        try:
            storage.save_bytes(key, payload)
        except Exception as exc:  # noqa: BLE001 - capture thread assertion
            failures.append(exc)

    threads = [
        threading.Thread(target=save, args=(keys[0], b"first")),
        threading.Thread(target=save, args=(keys[1], b"second")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert failures == []
    assert client.objects[(storage.bucket, keys[0])] == b"first"
    assert client.objects[(storage.bucket, keys[1])] == b"second"
    assert not list(storage.root.glob(".*.part"))


def test_s3_cache_ttl_removes_stale_local_copy(monkeypatch):
    import os

    from app.config import settings

    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 1024)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 1)
    storage = S3ObjectStore()
    stale = storage.new_key(".bin")
    fresh = storage.new_key(".bin")
    storage.save_bytes(stale, b"stale")
    old = time.time() - 10
    os.utime(storage.root / stale, (old, old))
    storage.save_bytes(fresh, b"fresh")

    assert not storage.root.joinpath(stale).exists()
    assert (storage.bucket, stale) in client.objects


def test_s3_cache_lease_prevents_evict_and_defers_delete(monkeypatch):
    from app.config import settings

    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 5)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 3600)
    storage = S3ObjectStore()
    leased_key = storage.new_key(".bin")
    other_key = storage.new_key(".bin")
    storage.save_bytes(leased_key, b"leased")

    with storage.local_path(leased_key) as leased_path:
        storage.save_bytes(other_key, b"other")
        assert leased_path.read_bytes() == b"leased"
        storage.delete(leased_key)
        assert leased_path.exists()
        assert (storage.bucket, leased_key) not in client.objects

    assert not storage.root.joinpath(leased_key).exists()
    assert storage._leases == {}


def test_s3_cache_converges_to_size_limit_when_lease_releases(monkeypatch):
    from app.config import settings

    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 5)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 3600)
    storage = S3ObjectStore()
    leased_key = storage.new_key(".bin")
    other_key = storage.new_key(".bin")
    storage.save_bytes(leased_key, b"leased")
    with storage.local_path(leased_key) as leased_path:
        storage.save_bytes(other_key, b"other")
        assert leased_path.read_bytes() == b"leased"
        assert sum(path.stat().st_size for path in storage.root.iterdir() if not path.name.startswith(".")) > 5

    assert sum(path.stat().st_size for path in storage.root.iterdir() if not path.name.startswith(".")) <= 5


def test_s3_normal_lease_release_does_not_rescan_cache(monkeypatch):
    from app.config import settings

    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    monkeypatch.setattr(settings, "s3_cache_max_bytes", 1024)
    monkeypatch.setattr(settings, "s3_cache_ttl_seconds", 3600)
    storage = S3ObjectStore()
    key = storage.new_key(".bin")
    storage.save_bytes(key, b"payload")
    calls = 0
    original_evict = storage._evict_cache

    def counting_evict(*, exclude=None):
        nonlocal calls
        calls += 1
        return original_evict(exclude=exclude)

    monkeypatch.setattr(storage, "_evict_cache", counting_evict)
    with storage.local_path(key) as local_path:
        assert local_path.read_bytes() == b"payload"
    assert calls == 0
