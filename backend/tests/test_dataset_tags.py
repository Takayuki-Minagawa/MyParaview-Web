"""Dataset tag mutation, search, RBAC, validation, and audit coverage."""

from __future__ import annotations


def _upload(client, project_id: str, data_dir, filename: str, headers: dict[str, str]):
    with open(data_dir / filename, "rb") as handle:
        return client.post(
            f"/projects/{project_id}/datasets",
            files={"file": (filename, handle, "application/octet-stream")},
            headers=headers,
        )


def test_dataset_tag_update_and_name_tag_search_preserve_rbac_and_audit(client, data_dir):
    owner = {"X-PVWeb-User": "tag-owner"}
    viewer = {"X-PVWeb-User": "tag-viewer"}
    outsider = {"X-PVWeb-User": "tag-outsider"}
    project_id = client.post(
        "/projects", json={"name": "tag-search"}, headers=owner
    ).json()["id"]
    grant = client.put(
        f"/projects/{project_id}/members/tag-viewer",
        json={"user_id": "tag-viewer", "role": "viewer"},
        headers=owner,
    )
    assert grant.status_code == 200

    surface = _upload(client, project_id, data_dir, "sample_surface.vtp", owner)
    points = _upload(client, project_id, data_dir, "sample_points.csv", owner)
    assert surface.status_code == 201
    assert points.status_code == 201
    dataset_id = surface.json()["id"]
    assert surface.json()["tags"] == []

    denied = client.patch(
        f"/datasets/{dataset_id}/tags",
        json={"tags": ["private"]},
        headers=viewer,
    )
    assert denied.status_code == 403
    assert client.patch(
        f"/datasets/{dataset_id}/tags",
        json={"tags": ["private"]},
        headers=outsider,
    ).status_code == 403

    updated = client.patch(
        f"/datasets/{dataset_id}/tags",
        json={"tags": ["  Review  ", "", "review", "Thermal"]},
        headers=owner,
    )
    assert updated.status_code == 200
    assert updated.json()["tags"] == ["Review", "Thermal"]
    assert client.get(f"/datasets/{dataset_id}", headers=viewer).json()["tags"] == [
        "Review",
        "Thermal",
    ]

    by_name = client.get(
        f"/projects/{project_id}/datasets",
        params={"name": "SURFACE"},
        headers=viewer,
    )
    assert [item["id"] for item in by_name.json()] == [dataset_id]
    by_tag = client.get(
        f"/projects/{project_id}/datasets",
        params={"tag": "thermal"},
        headers=viewer,
    )
    assert [item["id"] for item in by_tag.json()] == [dataset_id]
    combined = client.get(
        f"/projects/{project_id}/datasets",
        params={"name": "points", "tag": "Thermal"},
        headers=viewer,
    )
    assert combined.json() == []
    assert client.get(
        f"/projects/{project_id}/datasets",
        params={"tag": "Therm"},
        headers=viewer,
    ).json() == []
    assert client.get(
        f"/projects/{project_id}/datasets",
        params={"tag": "Thermal"},
        headers=outsider,
    ).status_code == 403

    audit = client.get(f"/projects/{project_id}/audit", headers=owner)
    tag_event = next(
        event
        for event in audit.json()
        if event["action"] == "patch"
        and event["resource_type"] == "dataset"
        and event["resource_id"] == dataset_id
        and event["status_code"] == 200
    )
    assert tag_event["detail"] == {
        "path": f"/datasets/{dataset_id}/tags",
        "tags": ["Review", "Thermal"],
    }


def test_dataset_tag_limits_do_not_mutate_existing_tags(client, data_dir):
    owner = {"X-PVWeb-User": "tag-limit-owner"}
    project_id = client.post(
        "/projects", json={"name": "tag-limits"}, headers=owner
    ).json()["id"]
    dataset_id = _upload(
        client, project_id, data_dir, "sample_surface.vtp", owner
    ).json()["id"]

    too_long = client.patch(
        f"/datasets/{dataset_id}/tags",
        json={"tags": ["x" * 51]},
        headers=owner,
    )
    assert too_long.status_code == 422
    too_many = client.patch(
        f"/datasets/{dataset_id}/tags",
        json={"tags": [f"tag-{index}" for index in range(21)]},
        headers=owner,
    )
    assert too_many.status_code == 422
    assert client.get(f"/datasets/{dataset_id}", headers=owner).json()["tags"] == []
