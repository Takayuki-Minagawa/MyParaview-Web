# MyParaView-Web

A ParaView-like web application for viewing and analysing CAE / CFD / FEA and
scientific datasets. This repository implements the **M1 MVP** slice of the
[work plan](./work_plan.md), which is itself derived from the technical research
in [`paraview_webapp_research.md`](./paraview_webapp_research.md).

> Scope note: this is the M1 MVP (ingest → metadata → browser rendering →
> pipelines → cancellable jobs). The heavy server-side rendering path (trame /
> ParaView `VtkRemoteView`) and formats such as CGNS/Exodus/EnSight/XDMF are
> planned for M2+ and are intentionally **not** implemented yet — the code
> reports those formats as "server-rendered" rather than faking support.

## Architecture (implemented subset)

```
React + vtk.js (frontend)  ──HTTP/JSON──▶  FastAPI (backend)
        │                                      │
        │  GET /datasets/{id}/download         ├─ SQLite  (projects, datasets, pipelines, jobs)
        └──────────────────────────────────────┤─ Object store (local FS stand-in for S3)
                                                └─ Job manager (thread pool, cancellable)
                                                       └─ metadata extractor (stdlib, no VTK)
```

The hybrid split from the research (browser rendering for small PolyData,
server-side for heavy data) is reflected in the frontend: only `PolyData` is
rendered in-browser via `vtk.js`; other dataset types show a "server-rendered"
placeholder.

## Backend

Requirements: Python 3.9+.

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

# run the API (http://localhost:8000, docs at /docs)
./.venv/bin/uvicorn app.main:app --reload

# run the tests
./.venv/bin/python -m pytest
```

### Metadata extraction

`app/metadata.py` parses **VTK XML native formats** (`.vtp/.vti/.vtu/.vts/.vtr`),
the **`.pvd`** time-series collection, and **CSV** tables using only the Python
standard library. Structural metadata (type, counts, array names/components,
image bounds) is always extracted; scalar *ranges* and point-derived *bounds*
are computed only for inline `format="ascii"` arrays. Binary/appended payloads
are reported structurally with `range: null` — an honest boundary where a
server-side VTK reader would later take over (see work_plan M2).

### API surface

| Method & path | Purpose |
|---|---|
| `POST /projects` · `GET /projects` · `GET/DELETE /projects/{id}` | project CRUD |
| `POST /projects/{id}/datasets` | upload (multipart, extension + magic check + quota) |
| `GET /projects/{id}/datasets` · `GET /datasets/{id}` | list / get dataset |
| `POST /datasets/{id}/ingest` | start metadata-extraction job (202) |
| `GET /datasets/{id}/metadata` | extracted metadata |
| `GET /datasets/{id}/download` | original object bytes (consumed by vtk.js) |
| `POST /pipelines` · `PATCH /pipelines/{id}` · `GET/DELETE` | reader→filter→representation DAG |
| `GET /jobs` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` | job status & cancellation |
| `GET /artifacts/{id}` | converted artifacts / screenshots |

## Frontend

Requirements: Node 20+.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 (expects the API on :8000)
npm run build      # production build
npm run test       # vitest unit tests
npm run typecheck  # tsc --noEmit
```

Configure the API base with `VITE_API_BASE` (default `http://localhost:8000`).

## What is tested

- **Backend** (`pytest`): metadata parsers for VTP/VTI/CSV/PVD; the full
  upload → ingest → metadata API flow; upload guardrails (extension, magic,
  content mismatch); pipeline CRUD; job cancellation semantics.
- **Frontend** (`vitest`): pure helpers — byte/count/bounds formatting and the
  cool-to-warm colormap / normalisation.

## Roadmap

See [`work_plan.md`](./work_plan.md). This repo delivers **M1**; M2 (CGNS/Exodus/
EnSight, more filters, volume rendering), M3 (large/time-series), and M4
(VTK.wasm / WebGPU) remain planned.
