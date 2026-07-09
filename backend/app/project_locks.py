"""In-process project operation guards for the SQLite/single-API deployment."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from collections.abc import Iterator

_LOCKS = tuple(threading.RLock() for _ in range(64))


@contextmanager
def project_guard(project_id: str) -> Iterator[None]:
    lock = _LOCKS[hash(project_id) % len(_LOCKS)]
    with lock:
        yield
