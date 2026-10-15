/** Browser-local datasets: files the user opens from their own machine (or
 * bundled samples) that are rendered without any server round trip.
 *
 * A local dataset reuses the server `Dataset` shape so the viewer, the
 * properties panel, comparison, and undo/redo work unchanged. The file bytes
 * live behind `blob:` URLs stored in `extra.local_urls`; metadata that the
 * server ingest would normally provide (arrays, counts, bounds) is filled in
 * by the viewer once the data is parsed (see `withSceneSummary`).
 */
import type { ArrayInfo, Dataset } from "../types";
import { parseCsv } from "./csvToPoints";

export const LOCAL_PROJECT_ID = "local";
export const LOCAL_ID_PREFIX = "local:";

export type BrowserDatasetType =
  | "PolyData"
  | "UnstructuredGrid"
  | "StructuredGrid"
  | "RectilinearGrid"
  | "ImageData"
  | "Table";

/** Extensions the vtk.js viewer renders directly. */
export const BROWSER_FORMATS: Readonly<Record<string, BrowserDatasetType>> = {
  ".vtp": "PolyData",
  ".vtu": "UnstructuredGrid",
  ".vts": "StructuredGrid",
  ".vtr": "RectilinearGrid",
  ".vti": "ImageData",
  ".csv": "Table",
};

/** Time-series descriptor whose referenced files must be browser formats. */
export const COLLECTION_EXTENSION = ".pvd";

/** Formats that need a ParaView worker (server mode) to convert. */
export const SERVER_ONLY_FORMATS: readonly string[] = [
  ".cgns", ".exo", ".e", ".case", ".xdmf", ".xmf", ".h5", ".hdf5",
];

export type FileClassification =
  | { kind: "browser"; ext: string; datasetType: BrowserDatasetType }
  | { kind: "collection"; ext: string }
  | { kind: "server"; ext: string }
  | { kind: "unknown"; ext: string };

export function fileExtension(name: string): string {
  const match = /\.[^./\\]+$/.exec(name);
  return match ? match[0].toLowerCase() : "";
}

export function classifyFileName(name: string): FileClassification {
  const ext = fileExtension(name);
  const datasetType = BROWSER_FORMATS[ext];
  if (datasetType) return { kind: "browser", ext, datasetType };
  if (ext === COLLECTION_EXTENSION) return { kind: "collection", ext };
  if (SERVER_ONLY_FORMATS.includes(ext)) return { kind: "server", ext };
  return { kind: "unknown", ext };
}

export type LocalDatasetErrorCode =
  | "no-files"
  | "unsupported"
  | "server-only"
  | "missing-files"
  | "invalid-pvd"
  | "needs-descriptor"
  | "empty-csv";

export class LocalDatasetError extends Error {
  readonly code: LocalDatasetErrorCode;
  /** File names or extensions the message should list. */
  readonly details: string[];

  constructor(code: LocalDatasetErrorCode, details: string[] = []) {
    super(`${code}${details.length ? `: ${details.join(", ")}` : ""}`);
    this.name = "LocalDatasetError";
    this.code = code;
    this.details = details;
  }
}

export interface PvdStep {
  time: number;
  file: string;
}

/** Parse a ParaView `.pvd` collection. One file per timestep is kept (the
 * first part); multi-part steps report how many parts were skipped. */
export function parsePvdCollection(text: string): { steps: PvdStep[]; skippedParts: number } {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new LocalDatasetError("invalid-pvd");
  }
  const root = document.documentElement;
  if (!root || root.tagName !== "VTKFile" || root.getAttribute("type") !== "Collection") {
    throw new LocalDatasetError("invalid-pvd");
  }
  const byTime = new Map<number, PvdStep>();
  let skippedParts = 0;
  for (const element of Array.from(document.getElementsByTagName("DataSet"))) {
    const file = (element.getAttribute("file") ?? "").trim();
    if (!file) continue;
    const timeRaw = element.getAttribute("timestep");
    const time = timeRaw === null || timeRaw.trim() === "" ? byTime.size : Number(timeRaw);
    if (!Number.isFinite(time)) throw new LocalDatasetError("invalid-pvd");
    if (byTime.has(time)) {
      skippedParts += 1;
      continue;
    }
    byTime.set(time, { time, file });
  }
  const steps = [...byTime.values()].sort((left, right) => left.time - right.time);
  if (steps.length === 0) throw new LocalDatasetError("invalid-pvd");
  return { steps, skippedParts };
}

function relativePath(file: File): string {
  const path = file.webkitRelativePath || file.name;
  return path.replace(/\\/g, "/");
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Resolve a PVD reference against the selected files. Exact relative path
 * first, then a unique basename match for flat selections. */
export function resolveReferencedFile(
  descriptorPath: string,
  reference: string,
  files: File[],
): File | null {
  const directory = directoryOf(normalizePath(descriptorPath));
  const wanted = normalizePath(directory ? `${directory}/${reference}` : reference);
  const exact = files.find((file) => normalizePath(relativePath(file)) === wanted);
  if (exact) return exact;
  const basename = wanted.split("/").pop() ?? wanted;
  const candidates = files.filter((file) => file.name === basename);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Column metadata for a CSV so the Table-to-Points picker can offer X/Y/Z
 * columns before the viewer parses the whole file. */
export function csvColumnInfo(text: string): ArrayInfo[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new LocalDatasetError("empty-csv");
  const header = rows[0].map((name, index) => (
    index === 0 ? name.replace(/^\uFEFF/, "").trim() : name.trim()
  ));
  const sample = rows.slice(1, 51);
  return header.map((name, column) => {
    const values = sample.map((row) => row[column]).filter(
      (cell) => cell !== undefined && cell.trim() !== "",
    );
    const numeric = values.length > 0 && values.every((cell) => Number.isFinite(Number(cell)));
    return {
      name,
      association: "table",
      num_components: 1,
      data_type: numeric ? "numeric" : "string",
    };
  });
}

export interface LocalDatasetSource {
  dataset: Dataset;
  /** One URL per timestep (a single entry for non-collections). */
  urls: string[];
  files: File[];
  /** Release the object URLs; the dataset must not be rendered afterwards. */
  revoke: () => void;
}

export interface CreateLocalDatasetOptions {
  /** Stable id suffix; defaults to a timestamp-based counter. */
  id?: string;
  /** Display name override (samples use their catalog label). */
  label?: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  now?: () => Date;
  readText?: (file: File) => Promise<string>;
}

let localCounter = 0;

function nextLocalId(): string {
  localCounter += 1;
  return `${LOCAL_ID_PREFIX}${Date.now().toString(36)}-${localCounter}`;
}

export function isLocalDatasetId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_ID_PREFIX);
}

export function isLocalDataset(dataset: Dataset | null | undefined): boolean {
  return !!dataset && (dataset.extra?.local === true || isLocalDatasetId(dataset.id));
}

/** URL the viewer should load for a dataset at the given timestep, or null
 * when the dataset is not a browser-local one. */
export function localDatasetUrl(dataset: Dataset, timestepIndex = 0): string | null {
  if (!isLocalDataset(dataset)) return null;
  const urls = dataset.extra?.local_urls;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const index = Math.max(0, Math.min(timestepIndex, urls.length - 1));
  const url = urls[index];
  return typeof url === "string" ? url : null;
}

/** Build a browser-local dataset from a single file or a PVD folder. */
export async function createLocalDataset(
  inputFiles: File[],
  options: CreateLocalDatasetOptions = {},
): Promise<LocalDatasetSource> {
  const files = inputFiles.filter((file) => !file.name.startsWith("."));
  if (files.length === 0) throw new LocalDatasetError("no-files");
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const readText = options.readText ?? ((file: File) => file.text());
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const id = options.id ?? nextLocalId();

  const descriptor = files.find((file) => classifyFileName(file.name).kind === "collection");
  const serverOnly = files.filter((file) => classifyFileName(file.name).kind === "server");
  if (!descriptor && serverOnly.length > 0 && files.length === serverOnly.length) {
    throw new LocalDatasetError("server-only", serverOnly.map((file) => file.name));
  }

  if (!descriptor) {
    if (files.length > 1) {
      throw new LocalDatasetError("needs-descriptor", files.map((file) => file.name));
    }
    const file = files[0];
    const classification = classifyFileName(file.name);
    if (classification.kind === "server") {
      throw new LocalDatasetError("server-only", [file.name]);
    }
    if (classification.kind !== "browser") {
      throw new LocalDatasetError("unsupported", [classification.ext || file.name]);
    }
    const arrays = classification.datasetType === "Table"
      ? csvColumnInfo(await readText(file))
      : null;
    const url = createObjectUrl(file);
    const dataset: Dataset = {
      id,
      project_id: LOCAL_PROJECT_ID,
      filename: options.label ?? file.name,
      ext: classification.ext,
      size_bytes: file.size,
      status: "ready",
      dataset_type: classification.datasetType,
      arrays,
      extra: { local: true, local_urls: [url], processing: "browser" },
      created_at: createdAt,
    };
    return {
      dataset,
      urls: [url],
      files: [file],
      revoke: () => revokeObjectUrl(url),
    };
  }

  const { steps, skippedParts } = parsePvdCollection(await readText(descriptor));
  const descriptorPath = relativePath(descriptor);
  const resolved: File[] = [];
  const missing: string[] = [];
  for (const step of steps) {
    const file = resolveReferencedFile(descriptorPath, step.file, files);
    if (file) resolved.push(file);
    else missing.push(step.file);
  }
  if (missing.length > 0) throw new LocalDatasetError("missing-files", missing);
  const innerTypes = new Set<string>();
  for (const file of resolved) {
    const classification = classifyFileName(file.name);
    if (classification.kind !== "browser") {
      throw new LocalDatasetError("server-only", [file.name]);
    }
    innerTypes.add(classification.datasetType);
  }
  if (innerTypes.size !== 1) {
    throw new LocalDatasetError("unsupported", [...innerTypes]);
  }
  const [innerType] = [...innerTypes];
  const urls = resolved.map((file) => createObjectUrl(file));
  const dataset: Dataset = {
    id,
    project_id: LOCAL_PROJECT_ID,
    filename: options.label ?? descriptor.name,
    ext: COLLECTION_EXTENSION,
    size_bytes: resolved.reduce((total, file) => total + file.size, descriptor.size),
    status: "ready",
    dataset_type: "Collection",
    timesteps: steps.map((step) => step.time),
    extra: {
      local: true,
      local_urls: urls,
      processing: "browser",
      inner_type: innerType,
      bundle_complete: true,
      member_count: resolved.length + 1,
      skipped_parts: skippedParts,
    },
    created_at: createdAt,
  };
  return {
    dataset,
    urls,
    files: [descriptor, ...resolved],
    revoke: () => urls.forEach((url) => revokeObjectUrl(url)),
  };
}

/** Metadata the viewer extracts after parsing a local file. */
export interface SceneSummary {
  num_points: number | null;
  num_cells: number | null;
  bounds: number[] | null;
  arrays: ArrayInfo[];
}

/** Merge viewer-derived metadata into a local dataset. Table datasets keep
 * their CSV column list (association `table`) so the coordinate picker and
 * color selection keep working. */
export function withSceneSummary(dataset: Dataset, summary: SceneSummary): Dataset {
  const keepColumns = dataset.dataset_type === "Table";
  const arrays = keepColumns
    ? (dataset.arrays ?? []).map((column) => {
      const runtime = summary.arrays.find(
        (array) => array.name === column.name && array.association === "point",
      );
      return runtime?.value_range ? { ...column, value_range: runtime.value_range } : column;
    })
    : summary.arrays;
  return {
    ...dataset,
    num_points: summary.num_points,
    num_cells: summary.num_cells,
    bounds: summary.bounds,
    arrays,
    extra: { ...(dataset.extra ?? {}), summary_source: "browser" },
  };
}
