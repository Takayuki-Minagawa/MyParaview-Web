"""Path-containment tests for multi-file bundle helpers (app/bundles.py)."""

from __future__ import annotations

import pytest

from app.bundles import bundle_reference_path, materialized_bundle_path, safe_relative_path


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("file.vtu", "file.vtu"),
        ("sub/file.vtu", "sub/file.vtu"),
        ("a/b/c/part0.vtu", "a/b/c/part0.vtu"),
        # Backslashes normalize to forward slashes before validation.
        ("sub\\file.vtu", "sub/file.vtu"),
        ("a\\b\\part0.vtu", "a/b/part0.vtu"),
        # Drive-letter prefixes are not absolute on POSIX; they become opaque
        # path segments that still resolve inside the bundle root.
        ("C:/data/file.vtu", "C:/data/file.vtu"),
        ("C:\\data\\file.vtu", "C:/data/file.vtu"),
        # Redundant separators and "." segments collapse instead of smuggling
        # empty parts; the normalized result stays inside the root.
        ("sub//file.vtu", "sub/file.vtu"),
        ("sub/file.vtu/", "sub/file.vtu"),
        ("./file.vtu", "file.vtu"),
        ("sub/./file.vtu", "sub/file.vtu"),
    ],
)
def test_safe_relative_path_accepts_contained_paths(filename: str, expected: str) -> None:
    assert safe_relative_path(filename) == expected


@pytest.mark.parametrize(
    "filename",
    [
        "",
        "..",
        "../evil.vtu",
        "sub/../../evil.vtu",
        "sub/..",
        "/etc/passwd",
        "/abs/file.vtu",
        # Backslash variants of traversal and absolute paths.
        "..\\evil.vtu",
        "sub\\..\\evil.vtu",
        "\\abs\\file.vtu",
        # UNC-style share paths normalize to an absolute POSIX path.
        "\\\\server\\share\\file.vtu",
        "//server/share/file.vtu",
    ],
)
def test_safe_relative_path_rejects_escape_attempts(filename: str) -> None:
    with pytest.raises(ValueError, match="unsafe relative path"):
        safe_relative_path(filename)


@pytest.mark.parametrize(
    ("primary", "reference", "expected"),
    [
        ("main.pvd", "part0.vtu", "part0.vtu"),
        ("main.pvd", "mesh/part0.vtu", "mesh/part0.vtu"),
        ("data/main.pvd", "part0.vtu", "data/part0.vtu"),
        ("data/main.pvd", "mesh/part0.vtu", "data/mesh/part0.vtu"),
        ("data/main.pvd", "mesh\\part0.vtu", "data/mesh/part0.vtu"),
    ],
)
def test_bundle_reference_path_resolves_relative_to_primary(
    primary: str, reference: str, expected: str
) -> None:
    assert bundle_reference_path(primary, reference) == expected


@pytest.mark.parametrize(
    "reference",
    ["", "..", "../sibling.vtu", "mesh/../../evil.vtu", "/abs/part0.vtu"],
)
def test_bundle_reference_path_rejects_unsafe_references(reference: str) -> None:
    with pytest.raises(ValueError, match="unsafe relative path"):
        bundle_reference_path("data/main.pvd", reference)


def test_dot_input_normalizes_but_never_materializes(tmp_path) -> None:
    # PurePosixPath drops "." segments before the parts check, so a bare "."
    # passes safe_relative_path unchanged; materialized_bundle_path is the
    # layer that refuses to map it onto the bundle root itself.
    assert safe_relative_path(".") == "."
    with pytest.raises(ValueError, match="unsafe bundle path"):
        materialized_bundle_path(tmp_path, ".")


def test_materialized_bundle_path_stays_inside_root(tmp_path) -> None:
    nested = materialized_bundle_path(tmp_path, "mesh/part0.vtu")
    assert nested == (tmp_path.resolve() / "mesh" / "part0.vtu")
    assert tmp_path.resolve() in nested.parents

    flat = materialized_bundle_path(tmp_path, "main.pvd")
    assert flat.parent == tmp_path.resolve()


@pytest.mark.parametrize("relative_path", ["..", "../evil.vtu", "/abs/evil.vtu", "", "."])
def test_materialized_bundle_path_rejects_traversal_inputs(tmp_path, relative_path: str) -> None:
    with pytest.raises(ValueError, match="unsafe"):
        materialized_bundle_path(tmp_path, relative_path)


def test_materialized_bundle_path_rejects_symlink_escape(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    (root / "link").symlink_to(outside)

    with pytest.raises(ValueError, match="unsafe bundle path"):
        materialized_bundle_path(root, "link/escaped.vtu")
