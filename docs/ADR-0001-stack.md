# ADR-0001: M1 MVP technology stack

Status: Accepted · Date: 2026-07-09

## Context

The [work plan](../work_plan.md) prescribes a two-stage approach: a fast PoC
(`trame`) followed by a productisation architecture (`React + vtk.js` front end,
`FastAPI` API, `pvpython`/VTK workers). This ADR records the concrete choices
for the **M1 MVP** implemented in this repository, given a development
environment without VTK/ParaView/GPU installed.

## Decisions

1. **Backend: FastAPI + SQLAlchemy 2.0 + SQLite.** Matches the work plan's API
   layer. SQLite stands in for PostgreSQL for the MVP; the ORM keeps the swap
   cheap. JSON columns hold array/timestep detail instead of separate
   `ArrayInfo`/`TimeStep` tables to keep the schema small.

2. **Metadata extraction without VTK.** VTK XML / PVD / CSV are parsed with the
   Python standard library (`xml.etree`, `csv`). This removes a heavy native
   dependency from the ingestion path and keeps the MVP installable anywhere.
   The trade-off — no ranges for binary/appended arrays, no CGNS/Exodus/EnSight
   — is exactly the boundary where a server-side VTK/`pvpython` worker takes
   over in M2.

3. **Object store: local filesystem behind an interface.** `ObjectStore`
   mirrors an S3-style key/stream API so a boto3/MinIO backend can replace it
   without touching routers or jobs.

4. **Jobs: in-process thread pool with cooperative cancellation.** Satisfies the
   work plan's "all jobs must be cancellable" requirement (8.2) without standing
   up Celery/Redis for the MVP. The submit/cancel/status-via-DB surface matches
   a distributed queue.

5. **Frontend: React 19 + Vite + TypeScript + vtk.js.** The productisation
   front end from the work plan. Browser rendering is scoped to `PolyData`
   surfaces (the research's "browser-direct" tier); other types are routed to a
   server-render placeholder rather than faked.

## Consequences

- The MVP runs with only Python and Node — no GPU, VTK, or ParaView — which
  makes it CI-friendly and easy to evaluate.
- Several M2+ items (server rendering via trame/`VtkRemoteView`, external
  scientific formats, volume rendering, Postgres, a real queue, OIDC/RBAC) are
  deliberately deferred and tracked in the work plan.
