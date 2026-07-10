from __future__ import annotations

import httpx

from app.config import settings


def _project(client) -> str:
    return client.post("/projects", json={"name": "remote-render"}).json()["id"]


def _dataset(client, project_id: str) -> str:
    response = client.post(
        f"/projects/{project_id}/datasets",
        files={"file": ("points.csv", b"x,y,z\n0,0,0\n", "text/csv")},
    )
    return response.json()["id"]


def test_session_broker_contract_and_lifecycle(client, monkeypatch):
    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", "http://broker.internal")

    def fake_post(url, **kwargs):
        assert url == "http://broker.internal/sessions"
        assert kwargs["json"]["dataset_id"] == dataset_id
        assert kwargs["json"]["ttl_seconds"] == settings.session_ttl_seconds
        return httpx.Response(
            201,
            json={"id": "remote-1", "websocket_url": "ws://broker.internal/ws/remote-1"},
            request=httpx.Request("POST", url),
        )

    deleted: list[str] = []
    monkeypatch.setattr("app.routers.sessions.httpx.post", fake_post)
    monkeypatch.setattr(
        "app.routers.sessions.httpx.delete",
        lambda url, **_kwargs: deleted.append(url) or httpx.Response(204),
    )

    response = client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    )
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["websocket_path"] == f"/sessions/{created['id']}/ws"
    assert created["websocket_protocol"].startswith("pvweb.")
    assert len(created["websocket_protocol"]) >= 38
    assert client.get(f"/sessions/{created['id']}").json()["status"] == "active"
    assert client.delete(f"/sessions/{created['id']}").status_code == 204
    assert deleted == ["http://broker.internal/sessions/remote-1"]


def test_session_creation_fails_honestly_without_broker(client, monkeypatch):
    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", None)
    response = client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    )
    assert response.status_code == 503
    assert "broker capability" in response.text


def test_session_rejects_broker_websocket_ssrf(client, monkeypatch):
    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", "http://broker.internal")
    monkeypatch.setattr(settings, "trame_allowed_ws_hosts", set())
    monkeypatch.setattr(
        "app.routers.sessions.httpx.post",
        lambda url, **_kwargs: httpx.Response(
            201,
            json={"id": "remote-ssrf", "websocket_url": "ws://169.254.169.254/latest"},
            request=httpx.Request("POST", url),
        ),
    )
    deleted: list[str] = []
    monkeypatch.setattr(
        "app.routers.sessions.httpx.delete",
        lambda url, **_kwargs: deleted.append(url) or httpx.Response(204),
    )
    response = client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    )
    assert response.status_code == 502
    assert "invalid WebSocket URL" in response.text
    assert deleted == ["http://broker.internal/sessions/remote-ssrf"]


def test_session_delete_failure_retains_local_record(client, monkeypatch):
    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", "http://broker.internal")
    monkeypatch.setattr(
        "app.routers.sessions.httpx.post",
        lambda url, **_kwargs: httpx.Response(
            201,
            json={"id": "remote-2", "websocket_url": "ws://broker.internal/ws/remote-2"},
            request=httpx.Request("POST", url),
        ),
    )
    monkeypatch.setattr(
        "app.routers.sessions.httpx.delete",
        lambda url, **_kwargs: httpx.Response(
            500,
            request=httpx.Request("DELETE", url),
        ),
    )
    created = client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    ).json()
    assert client.delete(f"/sessions/{created['id']}").status_code == 502
    assert client.get(f"/sessions/{created['id']}").status_code == 200


def test_project_delete_stops_and_cascades_render_sessions(client, monkeypatch):
    from app.db import SessionLocal

    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", "http://broker.internal")
    monkeypatch.setattr(
        "app.routers.sessions.httpx.post",
        lambda url, **_kwargs: httpx.Response(
            201,
            json={"id": "remote-project", "websocket_url": "ws://broker.internal/ws/project"},
            request=httpx.Request("POST", url),
        ),
    )
    deleted: list[str] = []
    broker_saw_unlocked_database = False

    def fake_delete(url, **_kwargs):
        nonlocal broker_saw_unlocked_database
        # The broker call must happen after the project-delete transaction has
        # committed. BEGIN IMMEDIATE would fail here if SQLite were still held.
        with SessionLocal() as db:
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
            broker_saw_unlocked_database = True
            db.rollback()
        deleted.append(url)
        return httpx.Response(204)

    monkeypatch.setattr("app.routers.sessions.httpx.delete", fake_delete)
    created = client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    ).json()
    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert broker_saw_unlocked_database
    assert deleted == ["http://broker.internal/sessions/remote-project"]
    assert client.get(f"/sessions/{created['id']}").status_code == 404


def test_project_delete_is_committed_when_remote_cleanup_fails(client, monkeypatch):
    project_id = _project(client)
    dataset_id = _dataset(client, project_id)
    monkeypatch.setattr(settings, "trame_broker_url", "http://broker.internal")
    monkeypatch.setattr(
        "app.routers.sessions.httpx.post",
        lambda url, **_kwargs: httpx.Response(
            201,
            json={"id": "remote-failure", "websocket_url": "ws://broker.internal/ws/failure"},
            request=httpx.Request("POST", url),
        ),
    )
    monkeypatch.setattr(
        "app.routers.sessions.httpx.delete",
        lambda url, **_kwargs: httpx.Response(500, request=httpx.Request("DELETE", url)),
    )
    client.post(
        "/sessions",
        json={"project_id": project_id, "dataset_id": dataset_id, "mode": "remote"},
    ).raise_for_status()

    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert client.get(f"/projects/{project_id}").status_code == 404
