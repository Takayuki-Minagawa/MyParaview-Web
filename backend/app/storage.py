"""Local-filesystem object store.

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


store = ObjectStore()
