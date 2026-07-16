"""ASGI responses with resource cleanup that also covers early returns/errors."""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Union

from fastapi import HTTPException
from fastapi.responses import RedirectResponse
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


def serve_object(
    store: ObjectStore,
    object_key: str,
    *,
    filename: str,
    media_type: Optional[str] = None,
) -> Union[RedirectResponse, LeasedFileResponse]:
    """Serve a stored object: presigned redirect when available, else a lease.

    Presigning does not verify the object exists; a redirect to a missing
    object would surface S3's raw 404 instead of the API's clean 410 below.
    Raises 410 when the object is gone from the store.
    """
    presigned = store.presigned_url(object_key, filename=filename)
    if presigned and store.exists(object_key):
        return RedirectResponse(presigned, status_code=307)
    path = store.acquire_path(object_key)
    if not path.is_file():
        store.release_path(object_key)
        raise HTTPException(410, "object no longer available")
    kwargs = {"media_type": media_type} if media_type else {}
    return LeasedFileResponse(
        str(path),
        store=store,
        object_key=object_key,
        filename=filename,
        **kwargs,
    )
