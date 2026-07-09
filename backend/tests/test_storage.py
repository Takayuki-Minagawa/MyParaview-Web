from __future__ import annotations

import io

import boto3
from botocore.exceptions import ClientError

from app.storage import S3ObjectStore


class FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    def upload_file(self, filename: str, bucket: str, key: str) -> None:
        with open(filename, "rb") as source:
            self.objects[(bucket, key)] = source.read()

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        if (bucket, key) not in self.objects:
            raise ClientError(
                {"Error": {"Code": "404"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
                "GetObject",
            )
        with open(filename, "wb") as target:
            target.write(self.objects[(bucket, key)])

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        return {"ContentLength": len(self.objects[(Bucket, Key)])}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        self.objects.pop((Bucket, Key), None)


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

    storage.delete(key)
    assert (storage.bucket, key) not in client.objects
    assert not storage.root.joinpath(key).exists()


def test_s3_missing_object_returns_nonexistent_cache_path(monkeypatch):
    client = FakeS3Client()
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    storage = S3ObjectStore()
    key = storage.new_key(".vtp")
    path = storage.path_for(key)
    assert not path.exists()
