"""Tiny dependency-free helper for opening MyParaView-Web views from Python/Jupyter."""

from __future__ import annotations

import webbrowser
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


@dataclass(frozen=True)
class PVWebClient:
    base_url: str = "http://localhost:5173"

    def view_url(
        self,
        *,
        project_id: str,
        dataset_id: Optional[str] = None,
        pipeline_id: Optional[str] = None,
    ) -> str:
        if not project_id:
            raise ValueError("project_id is required")
        if dataset_id and pipeline_id:
            raise ValueError("select dataset_id or pipeline_id, not both")
        parsed = urlsplit(self.base_url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        for reserved in ("project", "dataset", "pipeline"):
            query.pop(reserved, None)
        query["project"] = project_id
        if dataset_id:
            query["dataset"] = dataset_id
        if pipeline_id:
            query["pipeline"] = pipeline_id
        path = parsed.path.rstrip("/") or "/"
        return urlunsplit((parsed.scheme, parsed.netloc, path, urlencode(query), parsed.fragment))

    def open_view(self, **kwargs: str) -> str:
        url = self.view_url(**kwargs)
        webbrowser.open(url)
        return url
