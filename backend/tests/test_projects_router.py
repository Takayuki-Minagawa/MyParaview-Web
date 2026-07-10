"""Dedicated tests for the projects router (app/routers/projects.py)."""

from __future__ import annotations

import uuid


def _new_project(client, prefix: str, headers: dict[str, str]) -> str:
    resp = client.post(
        "/projects", json={"name": f"{prefix}-{uuid.uuid4().hex[:8]}"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_last_admin_cannot_be_demoted_until_another_admin_exists(client):
    admin_id = f"proj-admin-{uuid.uuid4().hex[:8]}"
    second_id = f"proj-second-{uuid.uuid4().hex[:8]}"
    admin = {"X-PVWeb-User": admin_id}
    pid = _new_project(client, "last-admin", admin)

    demoted = client.put(
        f"/projects/{pid}/members/{admin_id}",
        json={"user_id": admin_id, "role": "viewer"},
        headers=admin,
    )
    assert demoted.status_code == 409
    assert "last admin" in demoted.text

    promoted = client.put(
        f"/projects/{pid}/members/{second_id}",
        json={"user_id": second_id, "role": "admin"},
        headers=admin,
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"

    demoted = client.put(
        f"/projects/{pid}/members/{admin_id}",
        json={"user_id": admin_id, "role": "viewer"},
        headers=admin,
    )
    assert demoted.status_code == 200
    assert demoted.json()["role"] == "viewer"

    members = client.get(f"/projects/{pid}/members", headers={"X-PVWeb-User": second_id})
    assert members.status_code == 200
    roles = {member["user_id"]: member["role"] for member in members.json()}
    assert roles == {admin_id: "viewer", second_id: "admin"}


def test_membership_endpoint_returns_own_role(client):
    admin_id = f"proj-member-admin-{uuid.uuid4().hex[:8]}"
    viewer_id = f"proj-member-viewer-{uuid.uuid4().hex[:8]}"
    admin = {"X-PVWeb-User": admin_id}
    viewer = {"X-PVWeb-User": viewer_id}
    pid = _new_project(client, "membership", admin)

    own = client.get(f"/projects/{pid}/membership", headers=admin)
    assert own.status_code == 200
    assert own.json()["role"] == "admin"
    assert own.json()["user_id"] == admin_id

    assert client.put(
        f"/projects/{pid}/members/{viewer_id}",
        json={"user_id": viewer_id, "role": "viewer"},
        headers=admin,
    ).status_code == 200
    granted = client.get(f"/projects/{pid}/membership", headers=viewer)
    assert granted.status_code == 200
    assert granted.json()["role"] == "viewer"
    assert granted.json()["user_id"] == viewer_id


def test_viewer_cannot_list_members(client):
    admin_id = f"proj-list-admin-{uuid.uuid4().hex[:8]}"
    viewer_id = f"proj-list-viewer-{uuid.uuid4().hex[:8]}"
    admin = {"X-PVWeb-User": admin_id}
    viewer = {"X-PVWeb-User": viewer_id}
    pid = _new_project(client, "list-members", admin)
    assert client.put(
        f"/projects/{pid}/members/{viewer_id}",
        json={"user_id": viewer_id, "role": "viewer"},
        headers=admin,
    ).status_code == 200

    assert client.get(f"/projects/{pid}/members", headers=admin).status_code == 200
    assert client.get(f"/projects/{pid}/members", headers=viewer).status_code == 403


def test_audit_log_requires_admin_and_returns_events(client):
    admin_id = f"proj-audit-admin-{uuid.uuid4().hex[:8]}"
    viewer_id = f"proj-audit-viewer-{uuid.uuid4().hex[:8]}"
    admin = {"X-PVWeb-User": admin_id}
    viewer = {"X-PVWeb-User": viewer_id}
    pid = _new_project(client, "audit-log", admin)
    assert client.put(
        f"/projects/{pid}/members/{viewer_id}",
        json={"user_id": viewer_id, "role": "viewer"},
        headers=admin,
    ).status_code == 200

    audit = client.get(f"/projects/{pid}/audit", headers=admin)
    assert audit.status_code == 200
    events = audit.json()
    assert any(
        event["actor_id"] == admin_id
        and event["action"] == "post"
        and event["resource_type"] == "project"
        and event["project_id"] == pid
        for event in events
    )
    assert any(
        event["actor_id"] == admin_id and event["action"] == "put"
        for event in events
    )

    assert client.get(f"/projects/{pid}/audit", headers=viewer).status_code == 403
