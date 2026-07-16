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

type TypedArray =
  | Float32Array | Float64Array
  | Int8Array | Int16Array | Int32Array
  | Uint8Array | Uint16Array | Uint32Array;

const VTK_TYPE_BYTES: Record<string, number> = {
  Int8: 1, UInt8: 1, Int16: 2, UInt16: 2, Int32: 4, UInt32: 4,
  Int64: 8, UInt64: 8, Float32: 4, Float64: 8,
};

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

function indexOfSequence(bytes: Uint8Array, text: string, from = 0): number {
  const target = Array.from(text, (character) => character.charCodeAt(0));
  outer: for (let index = from; index <= bytes.length - target.length; index += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (bytes[index + offset] !== target[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("zlib-compressed VTU requires DecompressionStream support");
  }
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readHeaderInts(bytes: Uint8Array, count: number, headerType: string): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(
      headerType === "UInt64"
        ? Number(view.getBigUint64(index * 8, true))
        : view.getUint32(index * 4, true),
    );
  }
  return values;
}

/** Decode one storage blob: [header][payload], zlib multi-block when compressed. */
async function decodeBlock(
  bytes: Uint8Array,
  headerType: string,
  compressed: boolean,
): Promise<Uint8Array> {
  const headerBytes = VTK_TYPE_BYTES[headerType];
  if (!compressed) {
    const [byteCount] = readHeaderInts(bytes, 1, headerType);
    return bytes.subarray(headerBytes, headerBytes + byteCount);
  }
  const [blockCount] = readHeaderInts(bytes, 1, headerType);
  const header = readHeaderInts(bytes, 3 + blockCount, headerType);
  const [, blockSize, lastBlockSize] = header;
  const compressedSizes = header.slice(3);
  let cursor = headerBytes * (3 + blockCount);
  const output = new Uint8Array(
    blockSize * (blockCount - 1) + (lastBlockSize || blockSize),
  );
  let written = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const chunk = await inflate(bytes.subarray(cursor, cursor + compressedSizes[index]));
    output.set(chunk, written);
    written += chunk.length;
    cursor += compressedSizes[index];
  }
  return output.subarray(0, written);
}

/** Base64 inline content with compression stores header and payload as two
 * separately encoded streams; without compression it is a single stream. */
async function decodeInline(
  text: string,
  headerType: string,
  compressed: boolean,
): Promise<Uint8Array> {
  const cleaned = text.replace(/\s+/g, "");
  if (!compressed) return decodeBlock(base64ToBytes(cleaned), headerType, false);
  const headerBytes = VTK_TYPE_BYTES[headerType];
  const firstChunkChars = 4 * Math.ceil(headerBytes / 3);
  const [blockCount] = readHeaderInts(
    base64ToBytes(cleaned.slice(0, firstChunkChars)), 1, headerType,
  );
  const fullHeaderChars = 4 * Math.ceil((headerBytes * (3 + blockCount)) / 3);
  const header = base64ToBytes(cleaned.slice(0, fullHeaderChars));
  const payload = base64ToBytes(cleaned.slice(fullHeaderChars));
  const joined = new Uint8Array(header.length + payload.length);
  joined.set(header, 0);
  joined.set(payload, header.length);
  return decodeBlock(joined, headerType, true);
}

function bytesToTyped(bytes: Uint8Array, type: string): TypedArray {
  // Copy to an aligned buffer: subarray offsets are not guaranteed aligned.
  const copy = bytes.slice();
  switch (type) {
    case "Float32": return new Float32Array(copy.buffer);
    case "Float64": return new Float64Array(copy.buffer);
    case "Int8": return new Int8Array(copy.buffer);
    case "UInt8": return copy;
    case "Int16": return new Int16Array(copy.buffer);
    case "UInt16": return new Uint16Array(copy.buffer);
    case "Int32": return new Int32Array(copy.buffer);
    case "UInt32": return new Uint32Array(copy.buffer);
    case "Int64": {
      const big = new BigInt64Array(copy.buffer);
      const values = new Float64Array(big.length);
      for (let index = 0; index < big.length; index += 1) values[index] = Number(big[index]);
      return values;
    }
    case "UInt64": {
      const big = new BigUint64Array(copy.buffer);
      const values = new Float64Array(big.length);
      for (let index = 0; index < big.length; index += 1) values[index] = Number(big[index]);
      return values;
    }
    default:
      throw new Error(`unsupported VTU data type ${type}`);
  }
}

interface ParserContext {
  headerType: string;
  compressed: boolean;
  appended: Uint8Array | null;
}

async function readDataArray(element: Element, context: ParserContext): Promise<Float64Array> {
  const type = element.getAttribute("type") ?? "Float64";
  const format = element.getAttribute("format") ?? "ascii";
  if (format === "ascii") {
    const text = element.textContent ?? "";
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const values = new Float64Array(parts.length);
    for (let index = 0; index < parts.length; index += 1) values[index] = Number(parts[index]);
    return values;
  }
  let raw: Uint8Array;
  if (format === "binary") {
    raw = await decodeInline(element.textContent ?? "", context.headerType, context.compressed);
  } else if (format === "appended") {
    if (!context.appended) {
      throw new Error("VTU references appended data but none is present");
    }
    const offset = Number(element.getAttribute("offset") ?? "0");
    raw = await decodeBlock(
      context.appended.subarray(offset), context.headerType, context.compressed,
    );
  } else {
    throw new Error(`unsupported VTU DataArray format "${format}"`);
  }
  const typed = bytesToTyped(raw, type);
  return typed instanceof Float64Array ? typed : Float64Array.from(typed);
}

function faceKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/** Parse a VTU document and extract its renderable surface. */
export async function parseVtuSurface(buffer: ArrayBuffer): Promise<VtuSurface> {
  const bytes = new Uint8Array(buffer);
  let appended: Uint8Array | null = null;
  let xmlText: string;
  const appendedTag = indexOfSequence(bytes, "<AppendedData");
  if (appendedTag >= 0) {
    const window = new TextDecoder().decode(
      bytes.subarray(appendedTag, Math.min(appendedTag + 200, bytes.length)),
    );
    const encoding = /encoding="([^"]+)"/.exec(window)?.[1] ?? "raw";
    if (encoding !== "raw") {
      throw new Error("base64-encoded AppendedData is not supported; use raw or inline binary");
    }
    const underscore = indexOfSequence(bytes, "_", appendedTag);
    if (underscore < 0) throw new Error("malformed AppendedData section");
    appended = bytes.subarray(underscore + 1);
    xmlText = `${new TextDecoder().decode(bytes.subarray(0, appendedTag))}</VTKFile>`;
  } else {
    xmlText = new TextDecoder().decode(bytes);
  }

  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  const vtkFile = document.querySelector("VTKFile");
  if (!vtkFile || vtkFile.getAttribute("type") !== "UnstructuredGrid") {
    throw new Error("not a VTU UnstructuredGrid file");
  }
  if ((vtkFile.getAttribute("byte_order") ?? "LittleEndian") !== "LittleEndian") {
    throw new Error("big-endian VTU files are not supported");
  }
  const compressor = vtkFile.getAttribute("compressor") ?? "";
  if (compressor && compressor !== "vtkZLibDataCompressor") {
    throw new Error(`unsupported VTU compressor ${compressor}`);
  }
  const context: ParserContext = {
    headerType: vtkFile.getAttribute("header_type") ?? "UInt32",
    compressed: !!compressor,
    appended,
  };

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
    pointChunks.push(await readDataArray(pointsElement, context));

    const cellArrays = new Map<string, Float64Array>();
    for (const arrayElement of Array.from(piece.querySelectorAll("Cells > DataArray"))) {
      const name = arrayElement.getAttribute("Name") ?? "";
      cellArrays.set(name, await readDataArray(arrayElement, context));
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
      entry.chunks.push(await readDataArray(arrayElement, context));
      pointArrayChunks.set(name, entry);
    }
    const pieceCellData = { arrays: new Map<string, Float64Array>(), components: new Map<string, number>() };
    for (const arrayElement of Array.from(piece.querySelectorAll("CellData > DataArray"))) {
      const name = arrayElement.getAttribute("Name") ?? "";
      pieceCellData.components.set(
        name, Number(arrayElement.getAttribute("NumberOfComponents") ?? "1"),
      );
      pieceCellData.arrays.set(name, await readDataArray(arrayElement, context));
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
