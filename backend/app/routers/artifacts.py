from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Artifact
from ..storage import store

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


@router.get("/{artifact_id}")
def get_artifact(artifact_id: str, db: Session = Depends(get_db)):
    art = db.get(Artifact, artifact_id)
    if art is None:
        raise HTTPException(404, "artifact not found")
    path = store.path_for(art.object_key)
    if not path.is_file():
        raise HTTPException(410, "artifact object no longer available")
    return FileResponse(str(path), media_type=art.content_type)
