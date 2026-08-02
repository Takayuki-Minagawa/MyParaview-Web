"""API integration tests exercising the M1 end-to-end flow."""

from __future__ import annotations

import io
import zipfile
from concurrent.futures import ThreadPoolExecutor

from conftest import wait_for_job


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_project_crud(client):
    resp = client.post("/projects", json={"name": "Demo"})
    assert resp.status_code == 201
    pid = resp.json()["id"]

    assert client.get(f"/projects/{pid}").json()["name"] == "Demo"
    assert any(p["id"] == pid for p in client.get("/projects").json())

    assert client.get("/projects/nope").status_code == 404


def test_delete_project_removes_dataset_bundle_and_artifact_objects(client, data_dir, monkeypatch):
    from sqlalchemy import or_, select

    from app.db import SessionLocal
    from app.models import Artifact, Dataset, DatasetFile, Job
    from app.storage import store

    project_id = _new_project(client, "object-cleanup")
    uploaded = client.post(
        f"/projects/{project_id}/dataset-bundles",
        files=[
            ("files", ("sample_series.pvd", (data_dir / "sample_series.pvd").read_bytes(), "application/xml")),
            ("files", ("series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
            ("files", ("series_step1.vtp", (data_dir / "series_step1.vtp").read_bytes(), "application/xml")),
        ],
    )
    assert uploaded.status_code == 201
    dataset_id = uploaded.json()["id"]
    export = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "export",
            "target_id": dataset_id,
            "params": {"output_format": "source"},
        },
    )
    assert wait_for_job(client, export.json()["id"])["status"] == "succeeded"

    with SessionLocal() as db:
        dataset_ids = list(db.scalars(select(Dataset.id).where(Dataset.project_id == project_id)))
        job_ids = list(db.scalars(select(Job.id).where(Job.project_id == project_id)))
        keys = set(db.scalars(select(Dataset.object_key).where(Dataset.project_id == project_id)))
        keys.update(db.scalars(select(DatasetFile.object_key).where(DatasetFile.dataset_id.in_(dataset_ids))))
        keys.update(
            db.scalars(
                select(Artifact.object_key).where(
                    or_(Artifact.dataset_id.in_(dataset_ids), Artifact.job_id.in_(job_ids))
                )
            )
        )
    assert keys and all(store.exists(key) for key in keys)
    from app.routers import projects as projects_router

    real_drain = projects_router.drain_object_deletions
    batch_sizes: list[int | None] = []

    def recording_drain(**kwargs):
        batch_sizes.append(kwargs.get("batch_size"))
        return real_drain(**kwargs)

    monkeypatch.setattr(projects_router, "drain_object_deletions", recording_drain)
    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert batch_sizes == [len(keys)]
    assert all(not store.exists(key) for key in keys)


def test_delete_project_rejects_active_jobs(client, data_dir):
    from app.db import SessionLocal
    from app.models import Job

    project_id = _new_project(client, "active-job-delete")
    dataset = _upload(client, project_id, data_dir, "sample_surface.vtp").json()
    with SessionLocal() as db:
        job = Job(
            project_id=project_id,
            kind="export",
            target_id=dataset["id"],
            status="running",
        )
        db.add(job)
        db.commit()
        job_id = job.id

    assert client.delete(f"/projects/{project_id}").status_code == 409
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None
        job.status = "failed"
        db.add(job)
        db.commit()
    assert client.delete(f"/projects/{project_id}").status_code == 204


def test_delete_pipeline_and_project_with_deterministic_self_references(client, data_dir):
    from app.db import SessionLocal
    from app.models import Dataset, Pipeline, PipelineNode, Project
    from app.storage import store

    def add_chain(project_id: str, suffix: str, dataset_id: str | None = None) -> str:
        with SessionLocal() as db:
            pipeline = Pipeline(id=f"pipeline-{suffix}", project_id=project_id, name="chain")
            db.add(pipeline)
            db.flush()
            reader = PipelineNode(
                id=f"000-reader-{suffix}",
                pipeline_id=pipeline.id,
                node_type="reader",
                name="Reader",
                params={},
                dataset_id=dataset_id,
            )
            db.add(reader)
            db.flush()
            consumer = PipelineNode(
                id=f"fff-consumer-{suffix}",
                pipeline_id=pipeline.id,
                node_type="representation",
                name="Representation",
                params={},
                input_id=reader.id,
            )
            db.add(consumer)
            db.commit()
            return pipeline.id

    pipeline_project = _new_project(client, "fk-pipeline-delete")
    pipeline_id = add_chain(pipeline_project, "single")
    assert client.delete(f"/pipelines/{pipeline_id}").status_code == 204
    with SessionLocal() as db:
        assert db.get(Pipeline, pipeline_id) is None
        assert db.get(PipelineNode, "000-reader-single") is None
        assert db.get(PipelineNode, "fff-consumer-single") is None

    project_id = _new_project(client, "fk-project-delete")
    dataset = _upload(client, project_id, data_dir, "sample_surface.vtp").json()
    add_chain(project_id, "cascade", dataset["id"])
    with SessionLocal() as db:
        object_key = db.get(Dataset, dataset["id"]).object_key
    assert store.exists(object_key)
    assert client.delete(f"/projects/{project_id}").status_code == 204
    with SessionLocal() as db:
        assert db.get(Project, project_id) is None
        assert db.get(PipelineNode, "000-reader-cascade") is None
        assert db.get(PipelineNode, "fff-consumer-cascade") is None
    assert not store.exists(object_key)


def test_single_upload_cleans_object_if_project_is_deleted_mid_request(client, data_dir, monkeypatch):
    from app.db import SessionLocal
    from app.models import Project
    from app.routers import datasets as dataset_router
    from app.storage import store

    project_id = _new_project(client, "upload-delete-race")
    original_save = dataset_router.store.save_stream
    saved_keys: list[str] = []

    def save_then_delete(key, stream, *, max_bytes):
        size = original_save(key, stream, max_bytes=max_bytes)
        saved_keys.append(key)
        with SessionLocal() as db:
            project = db.get(Project, project_id)
            assert project is not None
            db.delete(project)
            db.commit()
        return size

    monkeypatch.setattr(dataset_router.store, "save_stream", save_then_delete)
    response = _upload(client, project_id, data_dir, "sample_surface.vtp")
    assert response.status_code in {404, 409}
    assert saved_keys and all(not store.exists(key) for key in saved_keys)


def test_project_rbac_and_audit_log(client, data_dir):
    alice = {"X-PVWeb-User": "alice"}
    bob = {"X-PVWeb-User": "bob"}
    project = client.post("/projects", json={"name": "secured"}, headers=alice).json()
    pid = project["id"]

    assert client.get(f"/projects/{pid}", headers=bob).status_code == 403
    assert all(item["id"] != pid for item in client.get("/projects", headers=bob).json())

    granted = client.put(
        f"/projects/{pid}/members/bob",
        json={"user_id": "bob", "role": "viewer"},
        headers=alice,
    )
    assert granted.status_code == 200
    assert client.get(f"/projects/{pid}", headers=bob).status_code == 200
    with open(data_dir / "sample_points.csv", "rb") as handle:
        denied = client.post(
            f"/projects/{pid}/datasets",
            files={"file": ("sample_points.csv", handle, "text/csv")},
            headers=bob,
        )
    assert denied.status_code == 403

    client.put(
        f"/projects/{pid}/members/bob",
        json={"user_id": "bob", "role": "editor"},
        headers=alice,
    )
    with open(data_dir / "sample_points.csv", "rb") as handle:
        allowed = client.post(
            f"/projects/{pid}/datasets",
            files={"file": ("sample_points.csv", handle, "text/csv")},
            headers=bob,
        )
    assert allowed.status_code == 201
    assert client.get(f"/projects/{pid}/members", headers=bob).status_code == 403
    membership = client.get(f"/projects/{pid}/membership", headers=bob)
    assert membership.status_code == 200
    assert membership.json()["role"] == "editor"
    pipeline = client.post(
        "/pipelines",
        json={"project_id": pid, "name": "audited", "nodes": []},
        headers=bob,
    )
    assert pipeline.status_code == 201
    downloaded = client.get(f"/datasets/{allowed.json()['id']}/download", headers=bob)
    assert downloaded.status_code == 200

    audit = client.get(f"/projects/{pid}/audit", headers=alice)
    assert audit.status_code == 200
    assert any(
        event["actor_id"] == "bob" and event["action"] == "post"
        for event in audit.json()
    )
    assert any(
        event["actor_id"] == "bob"
        and event["resource_type"] == "pipeline"
        and event["project_id"] == pid
        for event in audit.json()
    )
    assert any(
        event["actor_id"] == "bob"
        and event["action"] == "get"
        and "/download" in event["detail"]["path"]
        for event in audit.json()
    )


def test_partial_oidc_configuration_fails_closed(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "auth_mode", "oidc")
    monkeypatch.setattr(settings, "oidc_issuer", None)
    monkeypatch.setattr(settings, "oidc_audience", "pvweb-api")
    monkeypatch.setattr(settings, "oidc_jwks_url", "https://identity.invalid/jwks")
    assert client.get("/projects").status_code == 503


def test_audit_storage_failure_is_logged_without_replacing_response(client, monkeypatch):
    import app.main as main

    class BrokenSession:
        def __enter__(self):
            raise RuntimeError("audit database unavailable")

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(main, "SessionLocal", BrokenSession)
    logged: list[tuple] = []
    monkeypatch.setattr(main.logger, "exception", lambda *args: logged.append(args))
    response = client.post("/projects", json={"name": "audit-log-failure"})
    assert response.status_code == 201
    assert logged and "failed to persist audit event" in logged[0][0]


def test_default_oidc_mode_rejects_unconfigured_and_header_identity(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "auth_mode", "oidc")
    monkeypatch.setattr(settings, "oidc_issuer", None)
    monkeypatch.setattr(settings, "oidc_audience", None)
    monkeypatch.setattr(settings, "oidc_jwks_url", None)
    response = client.get("/projects", headers={"X-PVWeb-User": "spoofed-admin"})
    assert response.status_code == 503


def test_oidc_bootstrap_subject_recovers_legacy_projects(client, monkeypatch):
    from app import auth
    from app.config import settings

    legacy = client.post("/projects", json={"name": "legacy-project"}).json()
    modern = client.post(
        "/projects",
        json={"name": "already-owned"},
        headers={"X-PVWeb-User": "existing-owner"},
    ).json()
    monkeypatch.setattr(settings, "auth_mode", "oidc")
    monkeypatch.setattr(settings, "oidc_issuer", "https://issuer.example")
    monkeypatch.setattr(settings, "oidc_audience", "pvweb-api")
    monkeypatch.setattr(settings, "oidc_jwks_url", "https://issuer.example/jwks")
    monkeypatch.setattr(settings, "bootstrap_admin_subjects", {"real-admin"})
    monkeypatch.setattr(auth, "_decode_oidc_token", lambda _token: auth.Principal("real-admin"))

    headers = {"Authorization": "Bearer test-token"}
    projects = client.get("/projects", headers=headers)
    assert projects.status_code == 200
    assert legacy["id"] in {project["id"] for project in projects.json()}
    assert modern["id"] not in {project["id"] for project in projects.json()}
    membership = client.get(f"/projects/{legacy['id']}/membership", headers=headers)
    assert membership.status_code == 200
    assert membership.json()["role"] == "admin"


def test_member_body_route_supports_uri_subject_and_preserves_last_admin(client):
    owner = {"X-PVWeb-User": "owner-uri-test"}
    project_id = client.post("/projects", json={"name": "uri-subject"}, headers=owner).json()["id"]
    uri_subject = "https://issuer.example/users/alice"
    granted = client.put(
        f"/projects/{project_id}/members",
        json={"user_id": uri_subject, "role": "viewer"},
        headers=owner,
    )
    assert granted.status_code == 200
    assert granted.json()["user_id"] == uri_subject

    rejected = client.put(
        f"/projects/{project_id}/members",
        json={"user_id": "owner-uri-test", "role": "viewer"},
        headers=owner,
    )
    assert rejected.status_code == 409
    assert client.get(f"/projects/{project_id}/members", headers=owner).status_code == 200


def test_concurrent_admin_demotions_cannot_remove_every_admin(client):
    first = {"X-PVWeb-User": "admin-race-first"}
    second = {"X-PVWeb-User": "admin-race-second"}
    project_id = client.post("/projects", json={"name": "admin-race"}, headers=first).json()["id"]
    assert client.put(
        f"/projects/{project_id}/members",
        json={"user_id": "admin-race-second", "role": "admin"},
        headers=first,
    ).status_code == 200

    def demote(subject: str, headers: dict[str, str]) -> int:
        return client.put(
            f"/projects/{project_id}/members",
            json={"user_id": subject, "role": "viewer"},
            headers=headers,
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda args: demote(*args), [
            ("admin-race-first", first),
            ("admin-race-second", second),
        ]))
    assert sorted(statuses) == [200, 409]
    members = client.get(f"/projects/{project_id}/members", headers=(first if statuses[0] == 409 else second))
    assert members.status_code == 200
    assert sum(member["role"] == "admin" for member in members.json()) == 1


def _new_project(client, name="P") -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _upload(client, pid, data_dir, filename):
    path = data_dir / filename
    with open(path, "rb") as fh:
        return client.post(
            f"/projects/{pid}/datasets",
            files={"file": (filename, fh, "application/octet-stream")},
        )


def test_upload_ingest_and_metadata_end_to_end(client, data_dir):
    pid = _new_project(client, "ingest")
    up = _upload(client, pid, data_dir, "sample_surface.vtp")
    assert up.status_code == 201, up.text
    ds = up.json()
    assert ds["status"] == "registered"
    assert ds["ext"] == ".vtp"
    assert ds["size_bytes"] > 0

    job = client.post(f"/datasets/{ds['id']}/ingest")
    assert job.status_code == 202
    finished = wait_for_job(client, job.json()["id"])
    assert finished["status"] == "succeeded", finished

    meta = client.get(f"/datasets/{ds['id']}/metadata").json()
    assert meta["status"] == "ready"
    assert meta["dataset_type"] == "PolyData"
    assert meta["num_points"] == 4
    assert meta["num_cells"] == 4
    assert meta["bounds"] == [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    names = {a["name"] for a in meta["arrays"]}
    assert {"temperature", "velocity", "cell_id"} <= names


def test_ingest_csv(client, data_dir):
    pid = _new_project(client, "csv")
    ds = _upload(client, pid, data_dir, "sample_points.csv").json()
    job = client.post(f"/datasets/{ds['id']}/ingest")
    finished = wait_for_job(client, job.json()["id"])
    assert finished["status"] == "succeeded"
    meta = client.get(f"/datasets/{ds['id']}/metadata").json()
    assert meta["dataset_type"] == "Table"
    assert meta["num_points"] == 4


def test_upload_ingest_and_download_pvd_bundle(client, data_dir, monkeypatch):
    pid = _new_project(client, "pvd-bundle")
    response = client.post(
        f"/projects/{pid}/dataset-bundles",
        files=[
            ("files", ("run/sample_series.pvd", (data_dir / "sample_series.pvd").read_bytes(), "application/xml")),
            ("files", ("run/series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
            ("files", ("run/series_step1.vtp", (data_dir / "series_step1.vtp").read_bytes(), "application/xml")),
        ],
    )
    assert response.status_code == 201, response.text
    dataset = response.json()
    assert dataset["filename"] == "sample_series.pvd"
    assert dataset["size_bytes"] > (data_dir / "sample_series.pvd").stat().st_size

    import app.services as services

    original_copyfile = services.shutil.copyfile
    copied: list[tuple[object, object]] = []

    def counting_copyfile(source, target):
        copied.append((source, target))
        return original_copyfile(source, target)

    monkeypatch.setattr(services.shutil, "copyfile", counting_copyfile)
    job = client.post(f"/datasets/{dataset['id']}/ingest")
    finished = wait_for_job(client, job.json()["id"])
    assert finished["status"] == "succeeded", finished
    assert len(copied) == 2

    metadata = client.get(f"/datasets/{dataset['id']}/metadata").json()
    assert metadata["dataset_type"] == "Collection"
    assert metadata["timesteps"] == [0.0, 1.5]
    assert metadata["extra"]["inner_type"] == "PolyData"
    assert metadata["num_points"] == 3

    steps = client.get(f"/datasets/{dataset['id']}/timesteps")
    assert steps.status_code == 200
    assert steps.json() == [
        {"index": 0, "time": 0.0, "parts": [0], "files": ["series_step0.vtp"]},
        {"index": 1, "time": 1.5, "parts": [0], "files": ["series_step1.vtp"]},
    ]
    first = client.get(f"/datasets/{dataset['id']}/timesteps/0/download")
    second = client.get(f"/datasets/{dataset['id']}/timesteps/1/download")
    assert first.status_code == 200 and b"temperature" in first.content
    assert second.status_code == 200 and first.content != second.content
    assert client.get(f"/datasets/{dataset['id']}/timesteps/2/download").status_code == 404
    audit = client.get(f"/projects/{pid}/audit").json()
    assert not any(
        f"/datasets/{dataset['id']}/timesteps/" in event["detail"]["path"]
        and event["detail"]["path"].endswith("/download")
        for event in audit
    )

    export = client.post(
        "/jobs",
        json={
            "project_id": pid,
            "kind": "export",
            "target_id": dataset["id"],
            "params": {"output_format": "source"},
        },
    )
    exported = wait_for_job(client, export.json()["id"])
    assert exported["status"] == "succeeded", exported
    artifact = client.get(f"/artifacts/{exported['result']['artifact_id']}")
    assert artifact.status_code == 200
    assert artifact.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(artifact.content)) as archive:
        assert set(archive.namelist()) == {
            "run/sample_series.pvd",
            "run/series_step0.vtp",
            "run/series_step1.vtp",
        }


def test_pvd_bundle_rejects_missing_or_escaping_references(client, data_dir):
    pid = _new_project(client, "pvd-invalid")
    missing = client.post(
        f"/projects/{pid}/dataset-bundles",
        files=[
            ("files", ("sample_series.pvd", (data_dir / "sample_series.pvd").read_bytes(), "application/xml")),
            ("files", ("series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
        ],
    )
    assert missing.status_code == 422

    escaping_pvd = (
        b'<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        b'<DataSet timestep="0" part="0" file="../series_step0.vtp"/>'
        b'</Collection></VTKFile>'
    )
    escaping = client.post(
        f"/projects/{pid}/dataset-bundles",
        files=[
            ("files", ("run/escape.pvd", escaping_pvd, "application/xml")),
            ("files", ("series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
        ],
    )
    assert escaping.status_code == 422


def test_pvd_bundle_rejects_unplayable_collections_and_tolerates_broken_later_frames(client, data_dir):
    pid = _new_project(client, "pvd-playback-guards")
    standalone = _upload(client, pid, data_dir, "sample_series.pvd")
    assert standalone.status_code == 201
    standalone_job = client.post(f"/datasets/{standalone.json()['id']}/ingest")
    assert wait_for_job(client, standalone_job.json()["id"])["status"] == "succeeded"
    standalone_meta = client.get(f"/datasets/{standalone.json()['id']}/metadata").json()
    assert standalone_meta["dataset_type"] == "Collection"
    assert standalone_meta["extra"]["bundle_complete"] is False

    repeated = (
        b'<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        b'<DataSet timestep="0" file="series_step0.vtp"/>'
        b'<DataSet timestep="0" file="series_step1.vtp"/>'
        b'</Collection></VTKFile>'
    )
    duplicate_time = client.post(
        f"/projects/{pid}/dataset-bundles",
        files=[
            ("files", ("series.pvd", repeated, "application/xml")),
            ("files", ("series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
            ("files", ("series_step1.vtp", (data_dir / "series_step1.vtp").read_bytes(), "application/xml")),
        ],
    )
    assert duplicate_time.status_code == 422
    assert "one DataSet per timestep" in duplicate_time.text

    broken_pvd = (
        b'<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        b'<DataSet timestep="0" file="series_step0.vtp"/>'
        b'<DataSet timestep="1" file="broken.vtp"/>'
        b'</Collection></VTKFile>'
    )
    uploaded = client.post(
        f"/projects/{pid}/dataset-bundles",
        files=[
            ("files", ("broken-series.pvd", broken_pvd, "application/xml")),
            ("files", ("series_step0.vtp", (data_dir / "series_step0.vtp").read_bytes(), "application/xml")),
            ("files", ("broken.vtp", b'<?xml version="1.0"?><VTKFile type="PolyData"><PolyData>', "application/xml")),
        ],
    )
    assert uploaded.status_code == 201, uploaded.text
    job = client.post(f"/datasets/{uploaded.json()['id']}/ingest")
    assert wait_for_job(client, job.json()["id"])["status"] == "succeeded"
    metadata = client.get(f"/datasets/{uploaded.json()['id']}/metadata").json()
    assert metadata["status"] == "ready"
    assert metadata["extra"]["bundle_complete"] is True


def test_standalone_pvd_cannot_enrich_from_another_object_key(client, data_dir):
    from app.db import SessionLocal
    from app.models import Dataset

    project_id = _new_project(client, "standalone-pvd-isolation")
    target = _upload(client, project_id, data_dir, "sample_surface.vtp").json()
    with SessionLocal() as db:
        target_key = db.get(Dataset, target["id"]).object_key
    pvd = (
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        f'<DataSet timestep="0" part="0" file="{target_key}"/>'
        '</Collection></VTKFile>'
    ).encode()
    uploaded = client.post(
        f"/projects/{project_id}/datasets",
        files={"file": ("isolated.pvd", pvd, "application/xml")},
    )
    assert uploaded.status_code == 201
    job = client.post(f"/datasets/{uploaded.json()['id']}/ingest")
    assert wait_for_job(client, job.json()["id"])["status"] == "succeeded"
    metadata = client.get(f"/datasets/{uploaded.json()['id']}/metadata").json()
    assert metadata["dataset_type"] == "Collection"
    assert metadata["num_points"] is None
    assert metadata["arrays"] == []


def test_ingest_failure_marks_dataset_error(client):
    pid = _new_project(client, "fail")
    # passes the .vtp magic sniff (starts with <?xml) but is malformed XML,
    # so parsing raises during ingest.
    resp = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("broken.vtp", b'<?xml version="1.0"?><VTKFile type="PolyData"><PolyData><Piece',
                        "application/octet-stream")},
    )
    assert resp.status_code == 201
    dsid = resp.json()["id"]
    job = client.post(f"/datasets/{dsid}/ingest").json()
    finished = wait_for_job(client, job["id"])
    assert finished["status"] == "failed"

    meta = client.get(f"/datasets/{dsid}/metadata").json()
    assert meta["status"] == "error"  # not stuck at "ingesting"
    assert meta["error"]


def test_external_reader_requires_configured_paraview_worker(client):
    pid = _new_project(client, "external-reader")
    response = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("mesh.cgns", b"\x89HDF\r\n\x1a\nplaceholder", "application/octet-stream")},
    )
    assert response.status_code == 201, response.text
    job = client.post(f"/datasets/{response.json()['id']}/ingest")
    failed = wait_for_job(client, job.json()["id"])
    assert failed["status"] == "failed"
    assert "PVWEB_PVPYTHON" in failed["log"]


def test_external_descriptor_bundle_preserves_sidecars(client):
    pid = _new_project(client, "ensight-bundle")
    case = b"FORMAT\ntype: ensight gold\nGEOMETRY\nmodel: model.geo change_coords_only\n"
    response = client.post(
        f"/projects/{pid}/external-dataset-bundles",
        files=[
            ("files", ("run/model.case", case, "text/plain")),
            ("files", ("run/model.geo", b"geometry sidecar", "application/octet-stream")),
        ],
    )
    assert response.status_code == 201, response.text
    dataset = response.json()
    assert dataset["filename"] == "model.case"
    ingest = client.post(f"/datasets/{dataset['id']}/ingest")
    assert wait_for_job(client, ingest.json()["id"])["status"] == "failed"

    export = client.post(
        "/jobs",
        json={
            "project_id": pid,
            "kind": "export",
            "target_id": dataset["id"],
            "params": {"output_format": "source"},
        },
    )
    finished = wait_for_job(client, export.json()["id"])
    artifact = client.get(f"/artifacts/{finished['result']['artifact_id']}")
    with zipfile.ZipFile(io.BytesIO(artifact.content)) as archive:
        assert set(archive.namelist()) == {"run/model.case", "run/model.geo"}

    unsafe_xdmf = (
        b'<?xml version="1.0"?><Xdmf><Domain><Grid><Attribute>'
        b'<DataItem Format="HDF">/etc/passwd:/values</DataItem>'
        b'</Attribute></Grid></Domain></Xdmf>'
    )
    unsafe = client.post(
        f"/projects/{pid}/external-dataset-bundles",
        files=[("files", ("run/unsafe.xdmf", unsafe_xdmf, "application/xml"))],
    )
    assert unsafe.status_code == 422
    assert "unsafe relative path" in unsafe.text

    unsafe_case = (
        b"FORMAT\ntype: ensight gold\nGEOMETRY\n"
        b"model: /etc/passwd change_coords_only\n"
    )
    unsafe_flagged = client.post(
        f"/projects/{pid}/external-dataset-bundles",
        files=[("files", ("run/unsafe.case", unsafe_case, "text/plain"))],
    )
    assert unsafe_flagged.status_code == 422


def test_pipeline_rejects_unknown_dataset_id(client):
    pid = _new_project(client, "unknownds")
    resp = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "p",
            "nodes": [{"node_type": "reader", "name": "r", "dataset_id": "nope", "params": {}}],
        },
    )
    assert resp.status_code == 422


def test_pipeline_rejects_cross_project_dataset(client, data_dir):
    p1 = _new_project(client, "owner")
    p2 = _new_project(client, "other")
    ds = _upload(client, p1, data_dir, "sample_surface.vtp").json()
    resp = client.post(
        "/pipelines",
        json={
            "project_id": p2,
            "name": "p",
            "nodes": [{"node_type": "reader", "name": "r", "dataset_id": ds["id"], "params": {}}],
        },
    )
    assert resp.status_code == 422


def test_upload_rejects_unknown_extension(client, data_dir):
    pid = _new_project(client)
    resp = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("evil.exe", b"MZ\x00\x00", "application/octet-stream")},
    )
    assert resp.status_code == 415


def test_upload_rejects_mismatched_content(client):
    pid = _new_project(client)
    # .vtp extension but the bytes are not VTK XML
    resp = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("fake.vtp", b"this is not xml at all", "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_download_roundtrip(client, data_dir):
    pid = _new_project(client)
    ds = _upload(client, pid, data_dir, "sample_image.vti").json()
    resp = client.get(f"/datasets/{ds['id']}/download")
    assert resp.status_code == 200
    assert b"<VTKFile" in resp.content


def test_pipeline_crud(client, data_dir):
    pid = _new_project(client, "pipe")
    ds = _upload(client, pid, data_dir, "sample_surface.vtp").json()

    create = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "surface + clip",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "r1",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "filter", "name": "Clip", "local_id": "f1",
                 "input_id": "r1", "params": {"axis": "x", "value": 0.5}},
            ],
        },
    )
    assert create.status_code == 201, create.text
    body = create.json()
    plid = body["id"]
    assert len(body["nodes"]) == 2
    # the filter's input_id must resolve to the reader node's real persisted id
    reader = next(n for n in body["nodes"] if n["node_type"] == "reader")
    clip = next(n for n in body["nodes"] if n["node_type"] == "filter")
    assert clip["input_id"] == reader["id"]

    patched = client.patch(
        f"/pipelines/{plid}",
        json={"nodes": [{"node_type": "representation", "name": "surface", "params": {"color_by": "temperature"}}]},
    )
    assert patched.status_code == 200
    assert len(patched.json()["nodes"]) == 1
    assert patched.json()["nodes"][0]["node_type"] == "representation"

    listed = client.get(f"/pipelines?project_id={pid}")
    assert listed.status_code == 200
    assert [pipeline["id"] for pipeline in listed.json()] == [plid]


def test_pipeline_view_state_validation_and_roundtrip(client, data_dir):
    pid = _new_project(client, "view-state")
    ds = _upload(client, pid, data_dir, "sample_surface.vtp").json()
    state = {
        "schema_version": 1,
        "representation": "surface",
        "color_by": {"name": "cell_id", "association": "cell"},
        "color_range": [0.0, 3.0],
        "opacity": 0.65,
        "color_map": "viridis",
        "legend_visible": True,
        "volume_opacity_points": [
            {"value": 0.0, "alpha": 0.0},
            {"value": 0.5, "alpha": 0.35},
            {"value": 1.0, "alpha": 1.0},
        ],
        "camera": {
            "position": [2.0, 2.0, 2.0],
            "focal_point": [0.5, 0.5, 0.5],
            "view_up": [0.0, 0.0, 1.0],
            "parallel_scale": 1.5,
        },
    }
    created = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "saved view",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "reader",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "representation", "name": "view", "input_id": "reader",
                 "params": {"view_state": state}},
            ],
        },
    )
    assert created.status_code == 201, created.text
    representation = next(
        node for node in created.json()["nodes"] if node["node_type"] == "representation"
    )
    assert representation["params"]["view_state"] == state

    custom_state = {**state, "color_map": "custom:Thermal%20Map:1z141z3"}
    custom = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "saved custom colormap view",
            "nodes": [
                {
                    "node_type": "representation",
                    "name": "custom view",
                    "params": {"view_state": custom_state},
                }
            ],
        },
    )
    assert custom.status_code == 201, custom.text
    assert custom.json()["nodes"][0]["params"]["view_state"] == custom_state

    custom_definition = {
        "id": "custom:Thermal%20Map:1z141z3",
        "label": "Thermal Map",
        "stops": [
            {"position": 0.0, "rgb": [0.0, 0.1, 0.2]},
            {"position": 0.5, "rgb": [0.4, 0.5, 0.6]},
            {"position": 1.0, "rgb": [0.8, 0.9, 1.0]},
        ],
    }
    portable_custom_state = {
        **state,
        "color_map": custom_definition["id"],
        "custom_color_map": custom_definition,
    }
    portable_custom = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "portable custom colormap view",
            "nodes": [
                {
                    "node_type": "representation",
                    "name": "portable custom view",
                    "params": {"view_state": portable_custom_state},
                }
            ],
        },
    )
    assert portable_custom.status_code == 201, portable_custom.text
    assert portable_custom.json()["nodes"][0]["params"]["view_state"] == portable_custom_state

    invalid_custom_definitions = [
        {
            **portable_custom_state,
            "custom_color_map": {**custom_definition, "id": "custom:Other:abc123"},
        },
        {
            **portable_custom_state,
            "custom_color_map": {
                **custom_definition,
                "stops": [
                    {"position": 0.0, "rgb": [0.0, 0.0, 0.0]},
                    {"position": 1.1, "rgb": [1.0, 1.0, 1.0]},
                ],
            },
        },
        {
            **portable_custom_state,
            "custom_color_map": {
                **custom_definition,
                "stops": [
                    {"position": 0.0, "rgb": [0.0, 0.0, 0.0]},
                    {"position": 0.75, "rgb": [0.5, 0.5, 0.5]},
                    {"position": 0.5, "rgb": [0.75, 0.75, 0.75]},
                    {"position": 1.0, "rgb": [1.0, 1.0, 1.0]},
                ],
            },
        },
        {
            **portable_custom_state,
            "custom_color_map": {
                **custom_definition,
                "stops": [
                    {"position": index / 4096, "rgb": [0.0, 0.0, 0.0]}
                    for index in range(4097)
                ],
            },
        },
        {
            **state,
            "custom_color_map": custom_definition,
        },
    ]
    for index, invalid_state in enumerate(invalid_custom_definitions):
        rejected_custom = client.post(
            "/pipelines",
            json={
                "project_id": pid,
                "name": f"invalid custom colormap {index}",
                "nodes": [
                    {
                        "node_type": "representation",
                        "name": "bad custom view",
                        "params": {"view_state": invalid_state},
                    }
                ],
            },
        )
        assert rejected_custom.status_code == 422

    bad = {**state, "opacity": 1.5}
    rejected = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "invalid",
            "nodes": [{"node_type": "representation", "name": "bad",
                       "params": {"view_state": bad}}],
        },
    )
    assert rejected.status_code == 422

    reversed_range = {**state, "color_range": [3.0, 0.0]}
    rejected_range = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "bad range",
            "nodes": [{"node_type": "representation", "name": "bad",
                       "params": {"view_state": reversed_range}}],
        },
    )
    assert rejected_range.status_code == 422

    bad_opacity_points = {
        **state,
        "volume_opacity_points": [{"value": 0.0, "alpha": 0.0}],
    }
    rejected_points = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "bad opacity points",
            "nodes": [
                {
                    "node_type": "representation",
                    "name": "bad",
                    "params": {"view_state": bad_opacity_points},
                }
            ],
        },
    )
    assert rejected_points.status_code == 422

    unknown_field = {**state, "unrecognized_display_field": True}
    rejected_unknown = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "unknown view state field",
            "nodes": [
                {
                    "node_type": "representation",
                    "name": "bad",
                    "params": {"view_state": unknown_field},
                }
            ],
        },
    )
    assert rejected_unknown.status_code == 422


def test_pipeline_rejects_unresolvable_input_id(client, data_dir):
    pid = _new_project(client, "badpipe")
    resp = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "broken",
            "nodes": [
                {"node_type": "filter", "name": "Clip", "input_id": "ghost", "params": {}},
            ],
        },
    )
    assert resp.status_code == 422


def test_cancel_completed_job_conflicts(client, data_dir):
    pid = _new_project(client, "cancel")
    ds = _upload(client, pid, data_dir, "sample_surface.vtp").json()
    job = client.post(f"/datasets/{ds['id']}/ingest").json()
    wait_for_job(client, job["id"])
    resp = client.post(f"/jobs/{job['id']}/cancel")
    assert resp.status_code == 409  # already terminal


def test_cancel_missing_job_404(client):
    assert client.post("/jobs/does-not-exist/cancel").status_code == 404
