from __future__ import annotations

from fastapi import Request
from starlette.responses import RedirectResponse

from app.config import settings
from app.main import _prefix_same_origin_redirect, app


def test_configured_root_path_drives_docs_and_redirects(client, monkeypatch):
    assert app.root_path == settings.root_path
    monkeypatch.setattr(app, "root_path", "/api")

    docs = client.get("/docs")
    assert docs.status_code == 200
    assert "url: '/api/openapi.json'" in docs.text

    redirect = client.get("/projects/", follow_redirects=False)
    assert redirect.status_code == 307
    assert redirect.headers["location"] == "http://testserver/api/projects"


def test_root_path_does_not_rewrite_external_redirects():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("pvweb.example.com", 443),
            "path": "/artifacts/a",
            "root_path": "/api",
            "query_string": b"",
            "headers": [(b"host", b"pvweb.example.com")],
        }
    )
    response = RedirectResponse("https://objects.example.com/signed")

    _prefix_same_origin_redirect(request, response)

    assert response.headers["location"] == "https://objects.example.com/signed"


def test_root_path_does_not_rewrite_same_origin_object_redirects():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("pvweb.example.com", 443),
            "path": "/artifacts/a",
            "root_path": "/api",
            "query_string": b"",
            "headers": [(b"host", b"pvweb.example.com")],
        }
    )
    response = RedirectResponse("https://pvweb.example.com/s3/signed")

    _prefix_same_origin_redirect(request, response)

    assert response.headers["location"] == "https://pvweb.example.com/s3/signed"
