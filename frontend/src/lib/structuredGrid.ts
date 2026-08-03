/// <reference lib="es2022.error" />

/** Browser-native VTS/VTR external-surface extraction.
 *
 * StructuredGrid points are read from their explicit xyz array; RectilinearGrid
 * points are expanded from the three coordinate arrays. The regular topology
 * is reduced to boundary quads for 3-D data, quads for 2-D data, lines for
 * 1-D data, or a vertex for a single point. Point arrays are preserved and
 * cell arrays are remapped to the emitted vtkPolyData cell order.
 */
import {
  parseVtkXmlDocument,
  readVtkDataArray,
  type VtkXmlParserContext,
} from "./vtkXml";

export type StructuredGridType = "StructuredGrid" | "RectilinearGrid";

/** Bound browser-native parsing before coordinate/attribute arrays allocate.
 * Larger datasets retain the documented server-side VTP conversion path. */
export const MAX_STRUCTURED_SOURCE_POINTS = 2_000_000;

export interface StructuredSurfaceArray {
  name: string;
  numberOfComponents: number;
  values: Float64Array;
}

export interface StructuredSurface {
  sourceType: StructuredGridType;
  numberOfPoints: number;
  /** xyz triplets */
  points: Float64Array;
  /** vtkCellArray layout: [n, id0..id(n-1), n, ...] */
  polys: Uint32Array;
  lines: Uint32Array;
  verts: Uint32Array;
  pointArrays: StructuredSurfaceArray[];
  /** Tuples follow vtk.js PolyData cell order: verts, lines, polys. */
  cellArrays: StructuredSurfaceArray[];
  sourceCellCount: number;
  primitiveCount: number;
}

type Extent = [number, number, number, number, number, number];
type Dimensions = [number, number, number];
type GridIndex = [number, number, number];
type ArrayMap = Map<string, StructuredSurfaceArray>;

interface PieceSurface {
  numberOfPoints: number;
  sourceCellCount: number;
  points: Float64Array;
  polys: number[];
  lines: number[];
  verts: number[];
  polySources: number[];
  lineSources: number[];
  vertSources: number[];
  pointArrays: ArrayMap;
  cellArrays: ArrayMap;
}

function parseExtent(piece: Element): { extent: Extent; dimensions: Dimensions } {
  const raw = (piece.getAttribute("Extent") ?? "").trim().split(/\s+/).map(Number);
  if (
    raw.length !== 6
    || raw.some((value) => !Number.isSafeInteger(value))
    || raw[1] < raw[0]
    || raw[3] < raw[2]
    || raw[5] < raw[4]
  ) {
    throw new Error("VTS/VTR Piece has an invalid Extent");
  }
  const extent = raw as Extent;
  return {
    extent,
    dimensions: [
      extent[1] - extent[0] + 1,
      extent[3] - extent[2] + 1,
      extent[5] - extent[4] + 1,
    ],
  };
}

function pointCount(dimensions: Dimensions): number {
  return dimensions[0] * dimensions[1] * dimensions[2];
}

function cellDimensions(dimensions: Dimensions): Dimensions {
  return dimensions.map((dimension) => Math.max(dimension - 1, 1)) as Dimensions;
}

function cellCount(dimensions: Dimensions): number {
  return pointCount(cellDimensions(dimensions));
}

function tupleCountError(name: string, expected: number, actual: number): Error {
  return new Error(`${name} has ${actual} values; expected ${expected}`);
}

async function readAttributeArrays(
  piece: Element,
  association: "PointData" | "CellData",
  tuples: number,
  context: VtkXmlParserContext,
): Promise<ArrayMap> {
  const arrays: ArrayMap = new Map();
  for (const element of Array.from(piece.querySelectorAll(`${association} > DataArray`))) {
    const name = element.getAttribute("Name") ?? "(unnamed)";
    const numberOfComponents = Number(element.getAttribute("NumberOfComponents") ?? "1");
    if (!Number.isSafeInteger(numberOfComponents) || numberOfComponents < 1) {
      throw new Error(`${association} array ${name} has invalid NumberOfComponents`);
    }
    const values = await readVtkDataArray(element, context);
    const expected = tuples * numberOfComponents;
    if (values.length !== expected) {
      throw tupleCountError(`${association} array ${name}`, expected, values.length);
    }
    arrays.set(name, { name, numberOfComponents, values });
  }
  return arrays;
}

async function readStructuredPoints(
  piece: Element,
  dimensions: Dimensions,
  context: VtkXmlParserContext,
): Promise<Float64Array> {
  const element = piece.querySelector("Points > DataArray");
  if (!element) throw new Error("VTS Piece has no Points DataArray");
  const points = await readVtkDataArray(element, context);
  const expected = pointCount(dimensions) * 3;
  if (points.length !== expected) throw tupleCountError("VTS Points", expected, points.length);
  return points;
}

async function readRectilinearPoints(
  piece: Element,
  dimensions: Dimensions,
  context: VtkXmlParserContext,
): Promise<Float64Array> {
  const elements = Array.from(piece.querySelectorAll("Coordinates > DataArray"));
  if (elements.length !== 3) {
    throw new Error("VTR Piece must contain exactly three coordinate DataArrays");
  }
  const coordinates = await Promise.all(elements.map((element) => readVtkDataArray(element, context)));
  for (let axis = 0; axis < 3; axis += 1) {
    if (coordinates[axis].length !== dimensions[axis]) {
      throw tupleCountError(
        `VTR axis ${axis} coordinates`, dimensions[axis], coordinates[axis].length,
      );
    }
  }
  const points = new Float64Array(pointCount(dimensions) * 3);
  let cursor = 0;
  for (let k = 0; k < dimensions[2]; k += 1) {
    for (let j = 0; j < dimensions[1]; j += 1) {
      for (let i = 0; i < dimensions[0]; i += 1) {
        points[cursor] = coordinates[0][i];
        points[cursor + 1] = coordinates[1][j];
        points[cursor + 2] = coordinates[2][k];
        cursor += 3;
      }
    }
  }
  return points;
}

function buildPieceTopology(dimensions: Dimensions) {
  const polys: number[] = [];
  const lines: number[] = [];
  const verts: number[] = [];
  const polySources: number[] = [];
  const lineSources: number[] = [];
  const vertSources: number[] = [];
  const cellDims = cellDimensions(dimensions);
  const activeAxes = ([0, 1, 2] as const).filter((axis) => dimensions[axis] > 1);
  const pointId = (index: GridIndex) => (
    (index[2] * dimensions[1] + index[1]) * dimensions[0] + index[0]
  );
  const sourceCellId = (index: GridIndex) => (
    (index[2] * cellDims[1] + index[1]) * cellDims[0] + index[0]
  );
  const withOffset = (index: GridIndex, axis: number, amount: number): GridIndex => {
    const result: GridIndex = [...index];
    result[axis] += amount;
    return result;
  };

  if (activeAxes.length === 0) {
    verts.push(1, 0);
    vertSources.push(0);
  } else if (activeAxes.length === 1) {
    const axis = activeAxes[0];
    for (let step = 0; step < dimensions[axis] - 1; step += 1) {
      const base: GridIndex = [0, 0, 0];
      base[axis] = step;
      lines.push(2, pointId(base), pointId(withOffset(base, axis, 1)));
      lineSources.push(sourceCellId(base));
    }
  } else if (activeAxes.length === 2) {
    const [axisA, axisB] = activeAxes;
    for (let b = 0; b < dimensions[axisB] - 1; b += 1) {
      for (let a = 0; a < dimensions[axisA] - 1; a += 1) {
        const base: GridIndex = [0, 0, 0];
        base[axisA] = a;
        base[axisB] = b;
        const plusA = withOffset(base, axisA, 1);
        const plusB = withOffset(base, axisB, 1);
        const plusAB = withOffset(plusA, axisB, 1);
        polys.push(4, pointId(base), pointId(plusA), pointId(plusAB), pointId(plusB));
        polySources.push(sourceCellId(base));
      }
    }
  } else {
    const emit = (points: GridIndex[], source: GridIndex) => {
      polys.push(4, ...points.map(pointId));
      polySources.push(sourceCellId(source));
    };
    // Visit the six boundary planes directly. Runtime and generated topology
    // are proportional to the rendered surface, not the full cell volume.
    for (let k = 0; k < dimensions[2] - 1; k += 1) {
      for (let j = 0; j < dimensions[1] - 1; j += 1) {
        const low: GridIndex = [0, j, k];
        const high: GridIndex = [dimensions[0] - 2, j, k];
        emit([low, [0, j, k + 1], [0, j + 1, k + 1], [0, j + 1, k]], low);
        emit([
          [high[0] + 1, j, k], [high[0] + 1, j + 1, k],
          [high[0] + 1, j + 1, k + 1], [high[0] + 1, j, k + 1],
        ], high);
      }
    }
    for (let k = 0; k < dimensions[2] - 1; k += 1) {
      for (let i = 0; i < dimensions[0] - 1; i += 1) {
        const low: GridIndex = [i, 0, k];
        const high: GridIndex = [i, dimensions[1] - 2, k];
        emit([low, [i + 1, 0, k], [i + 1, 0, k + 1], [i, 0, k + 1]], low);
        emit([
          [i, high[1] + 1, k], [i, high[1] + 1, k + 1],
          [i + 1, high[1] + 1, k + 1], [i + 1, high[1] + 1, k],
        ], high);
      }
    }
    for (let j = 0; j < dimensions[1] - 1; j += 1) {
      for (let i = 0; i < dimensions[0] - 1; i += 1) {
        const low: GridIndex = [i, j, 0];
        const high: GridIndex = [i, j, dimensions[2] - 2];
        emit([low, [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0]], low);
        emit([
          [i, j, high[2] + 1], [i + 1, j, high[2] + 1],
          [i + 1, j + 1, high[2] + 1], [i, j + 1, high[2] + 1],
        ], high);
      }
    }
  }
  return { polys, lines, verts, polySources, lineSources, vertSources };
}

async function parsePiece(
  piece: Element,
  sourceType: StructuredGridType,
  context: VtkXmlParserContext,
): Promise<PieceSurface> {
  const { dimensions } = parseExtent(piece);
  const numberOfPoints = pointCount(dimensions);
  const sourceCellCount = cellCount(dimensions);
  const points = sourceType === "StructuredGrid"
    ? await readStructuredPoints(piece, dimensions, context)
    : await readRectilinearPoints(piece, dimensions, context);
  const [pointArrays, cellArrays] = await Promise.all([
    readAttributeArrays(piece, "PointData", numberOfPoints, context),
    readAttributeArrays(piece, "CellData", sourceCellCount, context),
  ]);
  return {
    numberOfPoints,
    sourceCellCount,
    points,
    ...buildPieceTopology(dimensions),
    pointArrays,
    cellArrays,
  };
}

function appendConnectivity(target: number[], source: number[], pointOffset: number): void {
  let cursor = 0;
  while (cursor < source.length) {
    const size = source[cursor];
    if (!Number.isSafeInteger(size) || size < 1 || cursor + size >= source.length) {
      throw new Error("invalid generated VTS/VTR connectivity");
    }
    target.push(size);
    for (let index = 1; index <= size; index += 1) {
      target.push(source[cursor + index] + pointOffset);
    }
    cursor += size + 1;
  }
}

function compatibleArrayNames(pieces: PieceSurface[], association: "pointArrays" | "cellArrays") {
  const first = pieces[0][association];
  return Array.from(first.keys()).filter((name) => {
    const components = first.get(name)?.numberOfComponents;
    return pieces.every((piece) => piece[association].get(name)?.numberOfComponents === components);
  });
}

function combinePieces(sourceType: StructuredGridType, pieces: PieceSurface[]): StructuredSurface {
  const totalPoints = pieces.reduce((sum, piece) => sum + piece.numberOfPoints, 0);
  const points = new Float64Array(totalPoints * 3);
  const polys: number[] = [];
  const lines: number[] = [];
  const verts: number[] = [];
  let pointOffset = 0;
  for (const piece of pieces) {
    points.set(piece.points, pointOffset * 3);
    appendConnectivity(polys, piece.polys, pointOffset);
    appendConnectivity(lines, piece.lines, pointOffset);
    appendConnectivity(verts, piece.verts, pointOffset);
    pointOffset += piece.numberOfPoints;
  }

  const pointArrays: StructuredSurfaceArray[] = [];
  for (const name of compatibleArrayNames(pieces, "pointArrays")) {
    const numberOfComponents = pieces[0].pointArrays.get(name)?.numberOfComponents ?? 1;
    const values = new Float64Array(totalPoints * numberOfComponents);
    let valueOffset = 0;
    for (const piece of pieces) {
      const source = piece.pointArrays.get(name)?.values;
      if (!source) continue;
      values.set(source, valueOffset);
      valueOffset += source.length;
    }
    pointArrays.push({ name, numberOfComponents, values });
  }

  const emitted = [
    ...pieces.flatMap((piece, pieceIndex) => piece.vertSources.map((cell) => ({ pieceIndex, cell }))),
    ...pieces.flatMap((piece, pieceIndex) => piece.lineSources.map((cell) => ({ pieceIndex, cell }))),
    ...pieces.flatMap((piece, pieceIndex) => piece.polySources.map((cell) => ({ pieceIndex, cell }))),
  ];
  const cellArrays: StructuredSurfaceArray[] = [];
  for (const name of compatibleArrayNames(pieces, "cellArrays")) {
    const numberOfComponents = pieces[0].cellArrays.get(name)?.numberOfComponents ?? 1;
    const values = new Float64Array(emitted.length * numberOfComponents);
    for (let outputCell = 0; outputCell < emitted.length; outputCell += 1) {
      const { pieceIndex, cell } = emitted[outputCell];
      const source = pieces[pieceIndex].cellArrays.get(name)?.values;
      if (!source) continue;
      for (let component = 0; component < numberOfComponents; component += 1) {
        values[outputCell * numberOfComponents + component] =
          source[cell * numberOfComponents + component];
      }
    }
    cellArrays.push({ name, numberOfComponents, values });
  }

  return {
    sourceType,
    numberOfPoints: totalPoints,
    points,
    polys: Uint32Array.from(polys),
    lines: Uint32Array.from(lines),
    verts: Uint32Array.from(verts),
    pointArrays,
    cellArrays,
    sourceCellCount: pieces.reduce((sum, piece) => sum + piece.sourceCellCount, 0),
    primitiveCount: emitted.length,
  };
}

/** Parse one VTS or VTR document. Unsupported variants fail with the existing
 * server-side VTP conversion as an explicit fallback, never a fake success. */
export async function parseStructuredSurface(buffer: ArrayBuffer): Promise<StructuredSurface> {
  try {
    const { document, context } = parseVtkXmlDocument(
      buffer, ["StructuredGrid", "RectilinearGrid"] as const,
    );
    const sourceType = context.fileType as StructuredGridType;
    const pieces = Array.from(document.querySelectorAll(`${sourceType} > Piece`));
    if (pieces.length === 0) throw new Error(`${sourceType} has no Piece elements`);
    const sourcePoints = pieces.reduce(
      (sum, piece) => sum + pointCount(parseExtent(piece).dimensions),
      0,
    );
    if (!Number.isSafeInteger(sourcePoints) || sourcePoints > MAX_STRUCTURED_SOURCE_POINTS) {
      throw new Error(
        `${sourceType} has ${sourcePoints} source points; browser limit is ${MAX_STRUCTURED_SOURCE_POINTS}`,
      );
    }
    return combinePieces(
      sourceType,
      await Promise.all(pieces.map((piece) => parsePiece(piece, sourceType, context))),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("server VTP conversion")) throw error;
    throw new Error(`${message}; use the server VTP conversion for this dataset`, { cause: error });
  }
}
