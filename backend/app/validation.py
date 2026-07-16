"""Content validation shared by the upload and artifact routers."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

from fastapi import HTTPException, UploadFile


def sniff_ok(ext: str, head: bytes) -> bool:
    """Lightweight magic/header check (work_plan 8.3): don't trust the extension."""
    if ext in {".vtp", ".vti", ".vtu", ".vts", ".vtr", ".pvd"}:
        prefix = head.lstrip()[:200].lower()
        return prefix.startswith(b"<?xml") or b"<vtkfile" in prefix or b"<collection" in prefix
    if ext == ".csv":
        # A UTF-8 multibyte char can straddle the 4 KB read boundary, so a strict
        # decode would false-reject valid (e.g. Japanese) CSVs. Treat as text
        # unless it contains a NUL byte (a reliable binary marker).
        return b"\x00" not in head
    if ext in {".xdmf", ".xmf"}:
        prefix = head.lstrip()[:300].lower()
        return prefix.startswith(b"<?xml") or b"<xdmf" in prefix
    if ext in {".cgns", ".exo", ".e"}:
        return head.startswith(b"\x89HDF\r\n\x1a\n") or head.startswith((b"CDF\x01", b"CDF\x02"))
    if ext == ".case":
        upper = head.upper()
        return b"\x00" not in head and b"FORMAT" in upper and b"GEOMETRY" in upper
    return False


async def sniff_upload(upload: UploadFile, ext: str, label: str) -> None:
    """Reject an upload whose leading bytes do not match its extension."""
    head = await upload.read(4096)
    if not sniff_ok(ext, head):
        raise HTTPException(400, f"file content does not match a {ext} file: {label}")
    await upload.seek(0)


def valid_png(path: Path) -> bool:
    """Validate PNG structure and per-chunk CRCs by streaming, not read_bytes()."""
    total = path.stat().st_size
    with open(path, "rb") as source:
        if source.read(8) != b"\x89PNG\r\n\x1a\n":
            return False
        offset = 8
        saw_header = False
        while offset + 12 <= total:
            header = source.read(8)
            if len(header) != 8:
                return False
            length = struct.unpack(">I", header[:4])[0]
            chunk_type = header[4:8]
            end = offset + 12 + length
            if end > total:
                return False
            crc = zlib.crc32(chunk_type)
            remaining = length
            first_payload = b""
            while remaining > 0:
                chunk = source.read(min(remaining, 1024 * 1024))
                if not chunk:
                    return False
                if not first_payload:
                    first_payload = chunk
                crc = zlib.crc32(chunk, crc)
                remaining -= len(chunk)
            crc_bytes = source.read(4)
            if len(crc_bytes) != 4:
                return False
            if crc & 0xFFFFFFFF != struct.unpack(">I", crc_bytes)[0]:
                return False
            if not saw_header:
                if chunk_type != b"IHDR" or length != 13 or len(first_payload) < 8:
                    return False
                width, height = struct.unpack(">II", first_payload[:8])
                if width == 0 or height == 0:
                    return False
                saw_header = True
            if chunk_type == b"IEND":
                return saw_header and length == 0 and end == total
            offset = end
    return False
