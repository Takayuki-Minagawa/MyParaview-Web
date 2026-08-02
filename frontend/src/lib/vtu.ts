/** Minimal VTU (XML UnstructuredGrid) parser with external-surface extraction.
 *
 * vtk.js (as of 36.x) ships no XMLUnstructuredGridReader, so browser-direct
 * VTU display parses the format here and renders the boundary surface as
 * PolyData. Supported storage: ascii, inline base64 binary, and raw appended
 * data — each optionally zlib-compressed (vtkZLibDataCompressor). Unsupported
 * inputs raise a descriptive error; callers surface it with a hint to use the
 * server VTP conversion instead.
 *
 * Cells: linear 3D cells (tetra/hexa/wedge/pyramid, incl. their VTK face
 * definitions) contribute their once-referenced (boundary) faces; 2D cells
 * pass through; lines/vertices are carried into the PolyData lines/verts.
 */
import { parseVtkXmlDocument, readVtkDataArray } from "./vtkXml";

export interface VtuArray {
  name: string;
  numberOfComponents: number;
  values: Float64Array;
}

export interface VtuSurface {
  numberOfPoints: number;
  /** xyz triplets */
  points: Float64Array;
  /** vtkCellArray layout: [n, id0..id(n-1), n, ...] */
  polys: Uint32Array;
  lines: Uint32Array;
  verts: Uint32Array;
  pointArrays: VtuArray[];
  /** One value tuple per emitted cell in vtk.js render order (verts, lines,
   * polys), each mapped from its originating VTU cell. */
  cellArrays: VtuArray[];
  /** Diagnostic counters for the caller's status line. */
  sourceCellCount: number;
  polyCount: number;
}

// VTK linear cell face tables (point orderings from VTK's cell definitions).
const CELL_FACES: Record<number, number[][]> = {
  10: [[0, 1, 3], [1, 2, 3], [2, 0, 3], [0, 2, 1]], // tetra
  12: [ // hexahedron
    [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7],
  ],
  13: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]], // wedge
  14: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], // pyramid
};
const CELL_2D = new Set([5, 8, 9, 7]); // triangle, pixel, quad, polygon
const CELL_LINE = new Set([3, 4]); // line, polyline
const CELL_VERTEX = new Set([1, 2]); // vertex, polyvertex

function faceKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/** Parse a VTU document and extract its renderable surface. */
export async function parseVtuSurface(buffer: ArrayBuffer): Promise<VtuSurface> {
  const { document, context } = parseVtkXmlDocument(buffer, "UnstructuredGrid");

  const pieces = Array.from(document.querySelectorAll("UnstructuredGrid > Piece"));
  if (pieces.length === 0) throw new Error("VTU has no Piece elements");

  const pointChunks: Float64Array[] = [];
  const polyIds: number[] = [];
  const lineIds: number[] = [];
  const vertIds: number[] = [];
  const polySourceCells: number[] = [];
  const lineSourceCells: number[] = [];
  const vertSourceCells: number[] = [];
  const pointArrayChunks = new Map<string, { numberOfComponents: number; chunks: Float64Array[] }>();
  const cellDataPerPiece: { arrays: Map<string, Float64Array>; components: Map<string, number> }[] = [];
  const pieceCellCounts: number[] = [];

  let pointOffset = 0;
  let totalCells = 0;

  for (const piece of pieces) {
    const numberOfPoints = Number(piece.getAttribute("NumberOfPoints") ?? "0");
    const pointsElement = piece.querySelector("Points > DataArray");
    if (!pointsElement) throw new Error("VTU Piece has no Points DataArray");
    pointChunks.push(await readVtkDataArray(pointsElement, context));

    const cellArrays = new Map<string, Float64Array>();
    for (const arrayElement of Array.from(piece.querySelectorAll("Cells > DataArray"))) {
      const name = arrayElement.getAttribute("Name") ?? "";
      cellArrays.set(name, await readVtkDataArray(arrayElement, context));
    }
    const connectivity = cellArrays.get("connectivity");
    const offsets = cellArrays.get("offsets");
    const types = cellArrays.get("types");
    if (!connectivity || !offsets || !types) {
      throw new Error("VTU Piece is missing connectivity/offsets/types");
    }

    // PointData arrays are concatenated across pieces alongside the points.
    for (const arrayElement of Array.from(piece.querySelectorAll("PointData > DataArray"))) {
      const name = arrayElement.getAttribute("Name") ?? "";
      const numberOfComponents = Number(arrayElement.getAttribute("NumberOfComponents") ?? "1");
      const entry = pointArrayChunks.get(name) ?? { numberOfComponents, chunks: [] };
      entry.chunks.push(await readVtkDataArray(arrayElement, context));
      pointArrayChunks.set(name, entry);
    }
    const pieceCellData = { arrays: new Map<string, Float64Array>(), components: new Map<string, number>() };
    for (const arrayElement of Array.from(piece.querySelectorAll("CellData > DataArray"))) {
      const name = arrayElement.getAttribute("Name") ?? "";
      pieceCellData.components.set(
        name, Number(arrayElement.getAttribute("NumberOfComponents") ?? "1"),
      );
      pieceCellData.arrays.set(name, await readVtkDataArray(arrayElement, context));
    }
    cellDataPerPiece.push(pieceCellData);

    // Boundary faces: count every 3D-cell face; those seen once are external.
    const faceUse = new Map<string, { ids: number[]; cell: number; count: number }>();
    const cellCount = types.length;
    let start = 0;
    for (let cell = 0; cell < cellCount; cell += 1) {
      const end = offsets[cell];
      const cellPointIds: number[] = [];
      for (let cursor = start; cursor < end; cursor += 1) {
        cellPointIds.push(connectivity[cursor] + pointOffset);
      }
      start = end;
      const type = types[cell];
      const globalCell = totalCells + cell;
      const faces = CELL_FACES[type];
      if (faces) {
        for (const face of faces) {
          const ids = face.map((cornerIndex) => cellPointIds[cornerIndex]);
          const key = faceKey(ids);
          const existing = faceUse.get(key);
          if (existing) existing.count += 1;
          else faceUse.set(key, { ids, cell: globalCell, count: 1 });
        }
      } else if (CELL_2D.has(type)) {
        // Pixel (8) uses a Z-order; swap to a quad winding.
        const ids = type === 8
          ? [cellPointIds[0], cellPointIds[1], cellPointIds[3], cellPointIds[2]]
          : cellPointIds;
        polyIds.push(ids.length, ...ids);
        polySourceCells.push(globalCell);
      } else if (CELL_LINE.has(type)) {
        lineIds.push(cellPointIds.length, ...cellPointIds);
        lineSourceCells.push(globalCell);
      } else if (CELL_VERTEX.has(type)) {
        vertIds.push(cellPointIds.length, ...cellPointIds);
        vertSourceCells.push(globalCell);
      } else {
        throw new Error(
          `VTU cell type ${type} is not supported in the browser; use the server VTP conversion`,
        );
      }
    }
    for (const { ids, cell, count } of faceUse.values()) {
      if (count === 1) {
        polyIds.push(ids.length, ...ids);
        polySourceCells.push(cell);
      }
    }

    pointOffset += numberOfPoints;
    totalCells += cellCount;
    pieceCellCounts.push(cellCount);
  }

  // Concatenate per-piece point coordinates and point arrays.
  const totalPointValues = pointChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const points = new Float64Array(totalPointValues);
  let cursor = 0;
  for (const chunk of pointChunks) {
    points.set(chunk, cursor);
    cursor += chunk.length;
  }
  const pointArrays: VtuArray[] = [];
  for (const [name, entry] of pointArrayChunks) {
    const length = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const values = new Float64Array(length);
    let offset = 0;
    for (const chunk of entry.chunks) {
      values.set(chunk, offset);
      offset += chunk.length;
    }
    pointArrays.push({ name, numberOfComponents: entry.numberOfComponents, values });
  }

  // Map cell data onto emitted polys via their source cell index.
  const cellArrayNames = new Set<string>();
  for (const pieceCellData of cellDataPerPiece) {
    for (const name of pieceCellData.arrays.keys()) cellArrayNames.add(name);
  }
  // Piece-local cell id ranges, to translate a global cell id back.
  const pieceCellStarts: number[] = [];
  {
    let cellStart = 0;
    for (const count of pieceCellCounts) {
      pieceCellStarts.push(cellStart);
      cellStart += count;
    }
  }
  const pieceForCell = (globalCell: number): number => {
    for (let index = pieceCellStarts.length - 1; index >= 0; index -= 1) {
      if (globalCell >= pieceCellStarts[index]) return index;
    }
    return 0;
  };
  // vtk.js indexes cell attributes over all cells in render order
  // verts -> lines -> polys, so the emitted tuples must follow that order.
  const emittedSourceCells = [...vertSourceCells, ...lineSourceCells, ...polySourceCells];
  const surfaceCellArrays: VtuArray[] = [];
  for (const name of cellArrayNames) {
    const components = cellDataPerPiece.find((piece) => piece.components.has(name))
      ?.components.get(name) ?? 1;
    const values = new Float64Array(emittedSourceCells.length * components);
    let ok = true;
    for (let emitted = 0; emitted < emittedSourceCells.length; emitted += 1) {
      const globalCell = emittedSourceCells[emitted];
      const pieceIndex = pieceForCell(globalCell);
      const local = globalCell - pieceCellStarts[pieceIndex];
      const source = cellDataPerPiece[pieceIndex]?.arrays.get(name);
      if (!source) { ok = false; break; }
      for (let component = 0; component < components; component += 1) {
        values[emitted * components + component] = source[local * components + component];
      }
    }
    if (ok) surfaceCellArrays.push({ name, numberOfComponents: components, values });
  }

  return {
    numberOfPoints: pointOffset,
    points,
    polys: Uint32Array.from(polyIds),
    lines: Uint32Array.from(lineIds),
    verts: Uint32Array.from(vertIds),
    pointArrays,
    cellArrays: surfaceCellArrays,
    sourceCellCount: totalCells,
    polyCount: polySourceCells.length,
  };
}
