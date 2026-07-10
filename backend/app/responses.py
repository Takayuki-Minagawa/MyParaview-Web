"""ASGI responses with resource cleanup that also covers early returns/errors."""

from __future__ import annotations

from pathlib import Path

from starlette.responses import FileResponse

from .storage import ObjectStore


class LeasedFileResponse(FileResponse):
    """Release an object-store path for every ASGI completion path.

    Starlette background tasks are skipped on malformed/unsatisfiable Range
    responses and when ``send`` raises after a client disconnect. Wrapping the
    complete FileResponse call in ``finally`` covers normal, early, and error
    exits without relying on background execution.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        store: ObjectStore,
        object_key: str,
        **kwargs,
    ) -> None:
        super().__init__(path, **kwargs)
        self._store = store
        self._object_key = object_key
        self._lease_released = False

    def _release_lease(self) -> None:
        if not self._lease_released:
            self._lease_released = True
            self._store.release_path(self._object_key)

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._release_lease()
