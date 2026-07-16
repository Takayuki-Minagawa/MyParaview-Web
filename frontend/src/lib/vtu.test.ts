// @vitest-environment jsdom
// (the parser needs DOMParser; other lib tests run in the node environment)
import { describe, expect, it } from "vitest";
import { parseVtuSurface } from "./vtu";

const encoder = new TextEncoder();

function asciiVtu(body: string): ArrayBuffer {
  const text = `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian">
  <UnstructuredGrid>
${body}
  </UnstructuredGrid>
</VTKFile>`;
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
}

/** One tetrahedron with a point scalar and a cell scalar. */
const TETRA_PIECE = `    <Piece NumberOfPoints="4" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">
          0 0 0  1 0 0  0 1 0  0 0 1
        </DataArray>
      </Points>
      <PointData>
        <DataArray type="Float32" Name="temp" NumberOfComponents="1" format="ascii">
          1 2 3 4
        </DataArray>
      </PointData>
      <CellData>
        <DataArray type="Float32" Name="pressure" NumberOfComponents="1" format="ascii">
          7
        </DataArray>
      </CellData>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">4</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">10</DataArray>
      </Cells>
    </Piece>`;

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

describe("parseVtuSurface", () => {
  it("extracts all four boundary faces of a single tetra (ascii)", async () => {
    const surface = await parseVtuSurface(asciiVtu(TETRA_PIECE));
    expect(surface.numberOfPoints).toBe(4);
    expect(surface.polyCount).toBe(4);
    // 4 triangles: each entry is [3, a, b, c]
    expect(surface.polys.length).toBe(16);
    expect(surface.pointArrays).toHaveLength(1);
    expect(surface.pointArrays[0].name).toBe("temp");
    expect(Array.from(surface.pointArrays[0].values)).toEqual([1, 2, 3, 4]);
    // Every boundary face inherits the owning cell's data.
    expect(surface.cellArrays).toHaveLength(1);
    expect(Array.from(surface.cellArrays[0].values)).toEqual([7, 7, 7, 7]);
  });

  it("removes shared interior faces between adjacent tetras", async () => {
    // Two tetras sharing face 0-1-2.
    const piece = `    <Piece NumberOfPoints="5" NumberOfCells="2">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">
          0 0 0  1 0 0  0 1 0  0 0 1  0 0 -1
        </DataArray>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3 0 2 1 4</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">4 8</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">10 10</DataArray>
      </Cells>
    </Piece>`;
    const surface = await parseVtuSurface(asciiVtu(piece));
    expect(surface.polyCount).toBe(6); // 8 faces - 2 shared
  });

  it("passes through 2D cells and reads inline binary points", async () => {
    const pointsB64 = inlineBinaryFloat32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const piece = `    <Piece NumberOfPoints="3" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="binary">${pointsB64}</DataArray>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">5</DataArray>
      </Cells>
    </Piece>`;
    const surface = await parseVtuSurface(asciiVtu(piece));
    expect(surface.polyCount).toBe(1);
    expect(Array.from(surface.polys)).toEqual([3, 0, 1, 2]);
    expect(surface.points[3]).toBe(1);
  });

  it("reads raw appended data with offsets", async () => {
    const points = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const connectivity = new Uint8Array(new Int32Array([0, 1, 2]).buffer);
    const blocks: Uint8Array[] = [];
    const offsets: number[] = [];
    for (const payload of [points, connectivity]) {
      offsets.push(blocks.reduce((sum, block) => sum + block.length, 0));
      const header = new Uint8Array(new Uint32Array([payload.length]).buffer);
      const joined = new Uint8Array(header.length + payload.length);
      joined.set(header, 0);
      joined.set(payload, header.length);
      blocks.push(joined);
    }
    const xml = `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32">
  <UnstructuredGrid>
    <Piece NumberOfPoints="3" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="appended" offset="${offsets[0]}"/>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="appended" offset="${offsets[1]}"/>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">5</DataArray>
      </Cells>
    </Piece>
  </UnstructuredGrid>
  <AppendedData encoding="raw">_`;
    const tail = encoder.encode("</AppendedData></VTKFile>");
    const head = encoder.encode(xml);
    const total = new Uint8Array(
      head.length + blocks.reduce((sum, block) => sum + block.length, 0) + tail.length,
    );
    total.set(head, 0);
    let cursor = head.length;
    for (const block of blocks) {
      total.set(block, cursor);
      cursor += block.length;
    }
    total.set(tail, cursor);
    const surface = await parseVtuSurface(total.buffer.slice(0, total.byteLength) as ArrayBuffer);
    expect(surface.polyCount).toBe(1);
    expect(surface.points[3]).toBe(1);
  });

  it("orders mixed-topology cell data as verts, lines, polys", async () => {
    // One vertex (id 0), one line (0-1), one triangle (0-1-2) with distinct
    // per-cell values in VTU order: triangle first, then line, then vertex —
    // the output must be re-ordered to vtk.js render order.
    const piece = `    <Piece NumberOfPoints="3" NumberOfCells="3">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0</DataArray>
      </Points>
      <CellData>
        <DataArray type="Float32" Name="tag" NumberOfComponents="1" format="ascii">10 20 30</DataArray>
      </CellData>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 0 1 0</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3 5 6</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">5 3 1</DataArray>
      </Cells>
    </Piece>`;
    const surface = await parseVtuSurface(asciiVtu(piece));
    expect(surface.polyCount).toBe(1);
    expect(Array.from(surface.lines)).toEqual([2, 0, 1]);
    expect(Array.from(surface.verts)).toEqual([1, 0]);
    // vtk.js cell order: vertex (30), line (20), triangle (10).
    expect(Array.from(surface.cellArrays[0].values)).toEqual([30, 20, 10]);
  });

  it("rejects unsupported cell types with a conversion hint", async () => {
    const piece = `    <Piece NumberOfPoints="3" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0</DataArray>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">21</DataArray>
      </Cells>
    </Piece>`;
    await expect(parseVtuSurface(asciiVtu(piece))).rejects.toThrow(/cell type 21/);
  });
});
