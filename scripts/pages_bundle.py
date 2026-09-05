"""Package a checked frontend or safely unpack a Pages release (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000


def unpack(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_FILES or sum(item.file_size for item in members) > MAX_BYTES:
            raise ValueError("Pages bundle exceeds size limit")
        names: set[str] = set()
        for item in members:
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename
                    or ":" in item.filename or stat.S_ISLNK(mode)
                    or item.filename in names):
                raise ValueError("Unsafe Pages bundle entry")
            names.add(item.filename)
        if "index.html" not in names:
            raise ValueError("Pages bundle must contain index.html at its root")
        # Only a fresh directory is accepted; existing symlinks cannot redirect extraction.
        destination.mkdir(parents=True, exist_ok=False)
        bundle.extractall(destination)


def pack(source: Path, destination: Path) -> None:
    if not (source / "index.html").is_file():
        raise ValueError("Build frontend/dist before packaging")
    paths = sorted(source.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Build output must not contain symlinks")
    files = [path for path in paths if path.is_file()]
    if len(files) + 1 > MAX_FILES or sum(path.stat().st_size for path in files) > MAX_BYTES:
        raise ValueError("Pages bundle exceeds size limit")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], text=True).strip())
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / "pages-site.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in files:
            bundle.write(path, path.relative_to(source).as_posix())
        bundle.writestr("build-info.json", json.dumps({"commit": commit, "dirty": dirty}))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n")
    print(f"Pages bundle: {archive}\nSHA-256: {digest}\nSource: {commit} (dirty={dirty})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["pack", "unpack"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    (pack if args.operation == "pack" else unpack)(args.source, args.destination)
