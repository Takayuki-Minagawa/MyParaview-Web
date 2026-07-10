"""Member removal and audit CSV/pagination features in the projects router."""

from __future__ import annotations

import csv
import io
import uuid


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_delete_member_removes_viewer(client):
    owner = {"X-PVWeb-User": _unique("member-owner")}
    project_id = client.post(
        "/projects", json={"name": _unique("member-delete")}, headers=owner
    ).json()["id"]
    subject = str(uuid.uuid4())

    granted = client.put(
        f"/projects/{project_id}/members",
        json={"user_id": subject, "role": "viewer"},
        headers=owner,
    )
    assert granted.status_code == 200
    members = client.get(f"/projects/{project_id}/members", headers=owner).json()
    assert subject in {member["user_id"] for member in members}

    removed = client.delete(
        f"/projects/{project_id}/members",
        params={"user_id": subject},
        headers=owner,
    )
    assert removed.status_code == 200
    assert removed.json()["user_id"] == subject
    assert removed.json()["role"] == "viewer"

    remaining = client.get(f"/projects/{project_id}/members", headers=owner).json()
    assert subject not in {member["user_id"] for member in remaining}
    assert {member["user_id"] for member in remaining} == {owner["X-PVWeb-User"]}


def test_delete_last_admin_conflicts(client):
    owner = {"X-PVWeb-User": _unique("last-admin")}
    project_id = client.post(
        "/projects", json={"name": _unique("last-admin")}, headers=owner
    ).json()["id"]

    denied = client.delete(
        f"/projects/{project_id}/members",
        params={"user_id": owner["X-PVWeb-User"]},
        headers=owner,
    )
    assert denied.status_code == 409

    members = client.get(f"/projects/{project_id}/members", headers=owner).json()
    assert [member["role"] for member in members] == ["admin"]


def test_delete_nonexistent_member_404(client):
    owner = {"X-PVWeb-User": _unique("missing-member")}
    project_id = client.post(
        "/projects", json={"name": _unique("missing-member")}, headers=owner
    ).json()["id"]

    missing = client.delete(
        f"/projects/{project_id}/members",
        params={"user_id": str(uuid.uuid4())},
        headers=owner,
    )
    assert missing.status_code == 404


def test_audit_csv_export_and_pagination(client):
    owner = {"X-PVWeb-User": _unique("audit-owner")}
    project_id = client.post(
        "/projects", json={"name": _unique("audit-csv")}, headers=owner
    ).json()["id"]
    # Generate several audited events (project create already logged one).
    for index in range(3):
        created = client.post(
            "/pipelines",
            json={"project_id": project_id, "name": f"audited-{index}", "nodes": []},
            headers=owner,
        )
        assert created.status_code == 201

    response = client.get(f"/projects/{project_id}/audit?format=csv", headers=owner)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == [
        "id",
        "created_at",
        "actor_id",
        "action",
        "resource_type",
        "resource_id",
        "status_code",
        "path",
    ]
    data_rows = rows[1:]
    assert len(data_rows) >= 4
    assert all(row[2] == owner["X-PVWeb-User"] for row in data_rows)
    assert any(row[3] == "post" and row[4] == "pipeline" for row in data_rows)

    full = client.get(f"/projects/{project_id}/audit", headers=owner).json()
    assert len(full) == len(data_rows)

    limited = client.get(f"/projects/{project_id}/audit?limit=1", headers=owner).json()
    assert len(limited) == 1

    offset = client.get(
        f"/projects/{project_id}/audit?limit=500&offset=1", headers=owner
    ).json()
    assert len(offset) == len(full) - 1
    assert {event["id"] for event in offset} <= {event["id"] for event in full}

    csv_limited = client.get(
        f"/projects/{project_id}/audit?format=csv&limit=2", headers=owner
    )
    assert csv_limited.status_code == 200
    limited_rows = list(csv.reader(io.StringIO(csv_limited.text)))
    assert len(limited_rows) == 3  # header + two data rows
