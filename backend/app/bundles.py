"""Shared path-containment helpers for uploaded multi-file datasets."""

from __future__ import annotations

from pathlib import Path, PurePosixPath


def safe_relative_path(filename: str) -> str:
    raw = filename.replace("\\", "/")
    path = PurePosixPath(raw)
    if not raw or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe relative path {filename!r}")
    return path.as_posix()


def bundle_reference_path(primary_path: str, reference: str) -> str:
    reference_path = safe_relative_path(reference)
    return safe_relative_path(
        (PurePosixPath(primary_path).parent / PurePosixPath(reference_path)).as_posix()
    )


def materialized_bundle_path(root: Path, relative_path: str) -> Path:
    normalized = safe_relative_path(relative_path)
    resolved_root = root.resolve()
    target = (resolved_root / normalized).resolve()
    if resolved_root not in target.parents:
        raise ValueError(f"unsafe bundle path {relative_path!r}")
    return target
