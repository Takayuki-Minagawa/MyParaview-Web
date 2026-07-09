from __future__ import annotations

from conftest import wait_for_job
from app.db import SessionLocal
from app.models import Dataset


def test_assistant_proposes_but_never_executes(client, data_dir):
    project = client.post("/projects", json={"name": "assistant"}).json()
    with open(data_dir / "sample_surface.vtp", "rb") as source:
        dataset = client.post(
            f"/projects/{project['id']}/datasets",
            files={"file": ("sample_surface.vtp", source, "application/xml")},
        ).json()
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"
    before_jobs = client.get(f"/jobs?project_id={project['id']}").json()

    proposal = client.post(
        "/assist/proposals",
        json={"dataset_id": dataset["id"], "prompt": "temperature の等値面を作りたい"},
    )
    assert proposal.status_code == 200
    body = proposal.json()
    assert body["action"] == "filter_job"
    assert body["params"]["filter"] == "contour"
    assert body["requires_confirmation"] is True
    assert client.get(f"/jobs?project_id={project['id']}").json() == before_jobs
    assert client.get(f"/artifacts?dataset_id={dataset['id']}").json() == []

    axis = client.post(
        "/assist/proposals",
        json={"dataset_id": dataset["id"], "prompt": "slice by temperature"},
    ).json()
    assert axis["params"]["normal"] == [0, 0, 1]

    unknown = client.post(
        "/assist/proposals",
        json={"dataset_id": dataset["id"], "prompt": "pressure contour"},
    ).json()
    assert unknown["action"] == "none"
    assert "pressure" in unknown["reason"]

    for prompt in (
        "contour pressure",
        "pressure を色付け",
        "等値面 pressure",
        "等値面を pressure で作る",
    ):
        body = client.post(
            "/assist/proposals",
            json={"dataset_id": dataset["id"], "prompt": prompt},
        ).json()
        assert body["action"] == "none"

    with SessionLocal() as db:
        stored = db.get(Dataset, dataset["id"])
        assert stored is not None
        arrays = list(stored.arrays or [])
        arrays[0] = {**arrays[0], "value_range": None}
        stored.arrays = arrays
        db.add(stored)
        db.commit()
    unknown_range = client.post(
        "/assist/proposals",
        json={"dataset_id": dataset["id"], "prompt": "temperature contour"},
    ).json()
    assert unknown_range["action"] == "none"
    assert "range" in unknown_range["reason"]
