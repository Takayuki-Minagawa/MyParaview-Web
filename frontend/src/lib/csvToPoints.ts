import type { TableCoordinates } from "../types";

export interface PointArray {
  name: string;
  values: Float32Array;
}

export interface CsvPointData {
  points: Float32Array;
  arrays: PointArray[];
  numberOfPoints: number;
  skippedRows: number;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value.replace(/\r$/, ""));
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export function csvToPointData(
  text: string,
  coordinates: TableCoordinates,
  maxPoints = 250_000,
): CsvPointData {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV is empty");
  const header = rows[0].map((name, index) => (
    index === 0 ? name.replace(/^\uFEFF/, "").trim() : name.trim()
  ));
  const coordinateIndexes = [coordinates.x, coordinates.y, coordinates.z].map((name) =>
    header.indexOf(name),
  );
  if (coordinateIndexes.some((index) => index < 0)) {
    throw new Error("selected X/Y/Z column was not found");
  }

  const finiteCell = (cell: string | undefined): number | null => {
    if (cell === undefined || cell.trim() === "") return null;
    const value = Number(cell);
    return Number.isFinite(value) ? value : null;
  };
  const accepted: Array<{ row: string[]; xyz: number[] }> = [];
  let skippedRows = 0;
  for (const row of rows.slice(1)) {
    const xyz = coordinateIndexes.map((index) => finiteCell(row[index]));
    if (xyz.some((value) => value === null)) {
      skippedRows += 1;
      continue;
    }
    accepted.push({ row, xyz: xyz as number[] });
    if (accepted.length > maxPoints) throw new Error(`CSV exceeds browser point limit ${maxPoints}`);
  }
  if (accepted.length === 0) throw new Error("CSV has no rows with finite X/Y/Z values");

  const points = new Float32Array(accepted.length * 3);
  accepted.forEach(({ xyz }, rowIndex) => {
    xyz.forEach((value, axis) => {
      points[rowIndex * 3 + axis] = value;
    });
  });

  const arrays: PointArray[] = [];
  header.forEach((name, columnIndex) => {
    if (!name) return;
    const values = new Float32Array(accepted.length);
    for (let rowIndex = 0; rowIndex < accepted.length; rowIndex += 1) {
      const value = finiteCell(accepted[rowIndex].row[columnIndex]);
      if (value === null) return;
      values[rowIndex] = value;
    }
    arrays.push({ name, values });
  });
  return { points, arrays, numberOfPoints: accepted.length, skippedRows };
}
