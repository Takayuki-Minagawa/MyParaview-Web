"""FastAPI application entry point.

Wires the M1 API surface (work_plan 7.2):
  projects / datasets (upload, ingest, metadata, download) / pipelines /
  jobs (status, cancel) / artifacts.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db
from .routers import artifacts, datasets, jobs, pipelines, projects


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="ParaView-like Web App API",
    version="0.1.0",
    summary="M1 MVP: dataset ingest, metadata, pipelines, cancellable jobs.",
    lifespan=lifespan,
)

_origins = os.environ.get("PVWEB_CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "service": "pvweb-api", "version": app.version}


app.include_router(projects.router)
app.include_router(datasets.router)
app.include_router(pipelines.router)
app.include_router(jobs.router)
app.include_router(artifacts.router)
