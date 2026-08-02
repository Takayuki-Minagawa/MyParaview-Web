// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_STRUCTURED_SOURCE_POINTS, parseStructuredSurface } from "./structuredGrid";

const encoder = new TextEncoder();

function fixture(name: string): ArrayBuffer {
  const bytes = readFileSync(resolve(process.cwd(), "src", "lib", "fixtures", name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function inlineBinaryFloat32(values: number[]): string {
  const payload = new Uint8Array(new Float32Array(values).buffer);
  const header = new Uint8Array(new Uint32Array([payload.length]).buffer);
  const joined = new Uint8Array(header.length + payload.length);
  joined.set(header, 0);
  joined.set(payload, header.length);
  return base64(joined);
}

function bufferOf(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("parseStructuredSurface", () => {
  it("extracts a VTS hexahedron boundary and preserves point/cell arrays", async () => {
    const surface = await parseStructuredSurface(fixture("sample_structured.vts"));
    expect(surface.sourceType).toBe("StructuredGrid");
    expect(surface.numberOfPoints).toBe(8);
    expect(surface.sourceCellCount).toBe(1);
    expect(surface.primitiveCount).toBe(6);
    expect(surface.polys).toHaveLength(30);
    expect(Array.from(surface.points.slice(21, 24))).toEqual([2, 1, 3]);
    expect(surface.pointArrays[0].name).toBe("temperature");
    expect(Array.from(surface.pointArrays[0].values)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(Array.from(surface.cellArrays[0].values)).toEqual([42, 42, 42, 42, 42, 42]);
  });

  it("expands VTR coordinates and emits only the ten exterior faces", async () => {
    const surface = await parseStructuredSurface(fixture("sample_rectilinear.vtr"));
    expect(surface.sourceType).toBe("RectilinearGrid");
    expect(surface.numberOfPoints).toBe(12);
    expect(surface.sourceCellCount).toBe(2);
    expect(surface.primitiveCount).toBe(10);
    expect(surface.polys).toHaveLength(50);
    expect(Array.from(surface.points.slice(0, 3))).toEqual([-1, 0, 2]);
    expect(Array.from(surface.points.slice(-3))).toEqual([2, 4, 5]);
    expect(Array.from(surface.cellArrays[0].values).sort((a, b) => a - b)).toEqual([
      10, 10, 10, 10, 10, 20, 20, 20, 20, 20,
    ]);
  });

  it("reads inline base64 VTS points for a two-dimensional grid", async () => {
    const points = inlineBinaryFloat32([
      0, 0, 0, 1, 0, 0,
      0, 1, 0, 1, 1, 0,
    ]);
    const xml = `<?xml version="1.0"?>
<VTKFile type="StructuredGrid" byte_order="LittleEndian" header_type="UInt32">
  <StructuredGrid WholeExtent="0 1 0 1 0 0">
    <Piece Extent="0 1 0 1 0 0">
      <Points><DataArray type="Float32" NumberOfComponents="3" format="binary">${points}</DataArray></Points>
    </Piece>
  </StructuredGrid>
</VTKFile>`;
    const surface = await parseStructuredSurface(bufferOf(xml));
    expect(surface.primitiveCount).toBe(1);
    expect(Array.from(surface.polys)).toEqual([4, 0, 1, 3, 2]);
  });

  it("reads raw-appended VTR coordinates and emits a line grid", async () => {
    const payload = new Uint8Array(new Float64Array([-2, 3]).buffer);
    const block = new Uint8Array(4 + payload.length);
    block.set(new Uint8Array(new Uint32Array([payload.length]).buffer), 0);
    block.set(payload, 4);
    const head = encoder.encode(`<?xml version="1.0"?>
<VTKFile type="RectilinearGrid" byte_order="LittleEndian" header_type="UInt32">
  <RectilinearGrid WholeExtent="0 1 0 0 0 0">
    <Piece Extent="0 1 0 0 0 0">
      <CellData><DataArray type="Int32" Name="segment" format="ascii">9</DataArray></CellData>
      <Coordinates>
        <DataArray type="Float64" format="appended" offset="0"/>
        <DataArray type="Float64" format="ascii">4</DataArray>
        <DataArray type="Float64" format="ascii">5</DataArray>
      </Coordinates>
    </Piece>
  </RectilinearGrid>
  <AppendedData encoding="raw">_`);
    const tail = encoder.encode("</AppendedData></VTKFile>");
    const bytes = new Uint8Array(head.length + block.length + tail.length);
    bytes.set(head, 0);
    bytes.set(block, head.length);
    bytes.set(tail, head.length + block.length);
    const surface = await parseStructuredSurface(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    expect(Array.from(surface.points)).toEqual([-2, 4, 5, 3, 4, 5]);
    expect(Array.from(surface.lines)).toEqual([2, 0, 1]);
    expect(Array.from(surface.cellArrays[0].values)).toEqual([9]);
  });

  it("fails unsupported variants with an explicit server conversion fallback", async () => {
    const xml = `<?xml version="1.0"?>
<VTKFile type="StructuredGrid" byte_order="BigEndian">
  <StructuredGrid><Piece Extent="0 0 0 0 0 0"/></StructuredGrid>
</VTKFile>`;
    await expect(parseStructuredSurface(bufferOf(xml))).rejects.toThrow(/server VTP conversion/);
  });

  it("rejects oversized grids before allocating point arrays", async () => {
    const xml = `<?xml version="1.0"?>
<VTKFile type="StructuredGrid" byte_order="LittleEndian">
  <StructuredGrid><Piece Extent="0 ${MAX_STRUCTURED_SOURCE_POINTS} 0 0 0 0"/></StructuredGrid>
</VTKFile>`;
    await expect(parseStructuredSurface(bufferOf(xml))).rejects.toThrow(
      /browser limit.*server VTP conversion/,
    );
  });
});
