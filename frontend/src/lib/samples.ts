/** Bundled sample datasets served from the static site (`public/samples/`).
 * They load through a same-origin fetch, so no permission prompt and no API
 * server is involved. The catalog deliberately includes failure cases so the
 * error paths can be exercised without preparing files. */
import { createLocalDataset, type LocalDatasetSource } from "./localDataset";

export type SampleExpectation = "ok" | "broken" | "server-only" | "missing-files";

export type SampleId =
  | "surface" | "unstructured" | "structured" | "rectilinear" | "image" | "points"
  | "series" | "broken" | "serverOnly" | "missingFiles";

export interface SampleDefinition {
  id: SampleId;
  /** Files relative to `samples/`; a folder-style set for PVD. */
  files: string[];
  expectation: SampleExpectation;
  /** Extension of the primary file, for the picker's format hint. */
  format: string;
}

export const SAMPLES: readonly SampleDefinition[] = [
  { id: "surface", files: ["wave_surface.vtp"], expectation: "ok", format: ".vtp" },
  { id: "unstructured", files: ["hex_block.vtu"], expectation: "ok", format: ".vtu" },
  { id: "structured", files: ["sample_structured.vts"], expectation: "ok", format: ".vts" },
  { id: "rectilinear", files: ["sample_rectilinear.vtr"], expectation: "ok", format: ".vtr" },
  { id: "image", files: ["radial_density.vti"], expectation: "ok", format: ".vti" },
  { id: "points", files: ["spiral_points.csv"], expectation: "ok", format: ".csv" },
  {
    id: "series",
    files: ["wave_series.pvd", "wave_step0.vtp", "wave_step1.vtp", "wave_step2.vtp", "wave_step3.vtp"],
    expectation: "ok",
    format: ".pvd",
  },
  { id: "broken", files: ["broken_surface.vtp"], expectation: "broken", format: ".vtp" },
  { id: "serverOnly", files: ["external_case.case"], expectation: "server-only", format: ".case" },
  { id: "missingFiles", files: ["missing_series.pvd"], expectation: "missing-files", format: ".pvd" },
];

export function sampleById(id: string): SampleDefinition | undefined {
  return SAMPLES.find((sample) => sample.id === id);
}

export function sampleUrl(baseUrl: string, file: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}samples/${file}`;
}

/** Download a sample's files as `File` objects. The viewer then treats them
 * exactly like files chosen from the local disk. */
export async function fetchSampleFiles(
  sample: SampleDefinition,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File[]> {
  return Promise.all(sample.files.map(async (name) => {
    const response = await fetchImpl(sampleUrl(baseUrl, name));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${name}`);
    // arrayBuffer() keeps the File usable across Blob implementations.
    const buffer = await response.arrayBuffer();
    const type = response.headers.get("content-type") || "application/octet-stream";
    return new File([buffer], name, { type });
  }));
}

export async function loadSample(
  sample: SampleDefinition,
  baseUrl: string,
  label: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalDatasetSource> {
  const files = await fetchSampleFiles(sample, baseUrl, fetchImpl);
  return createLocalDataset(files, { label });
}
