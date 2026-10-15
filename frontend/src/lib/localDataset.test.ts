// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  classifyFileName,
  createLocalDataset,
  csvColumnInfo,
  isLocalDataset,
  isLocalDatasetId,
  CSV_SAMPLE_BYTES,
  LocalDatasetError,
  readCsvHead,
  localDatasetUrl,
  parsePvdCollection,
  resolveReferencedFile,
  withSceneSummary,
} from "./localDataset";

const PVD = `<?xml version="1.0"?>
<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">
  <Collection>
    <DataSet timestep="1.5" part="0" file="step1.vtp"/>
    <DataSet timestep="0" part="0" file="sub/step0.vtp"/>
    <DataSet timestep="0" part="1" file="sub/step0_part1.vtp"/>
  </Collection>
</VTKFile>`;

function file(name: string, content = "x", relativePath?: string): File {
  const created = new File([content], name, { type: "text/plain" });
  if (relativePath) {
    Object.defineProperty(created, "webkitRelativePath", { value: relativePath });
  }
  return created;
}

const urlOptions = {
  createObjectUrl: (blob: Blob) => `blob:${(blob as File).name}`,
  revokeObjectUrl: () => {},
  now: () => new Date("2026-10-15T00:00:00Z"),
};

describe("classifyFileName", () => {
  it("maps extensions to browser, collection, server, or unknown", () => {
    expect(classifyFileName("mesh.VTP")).toEqual({ kind: "browser", ext: ".vtp", datasetType: "PolyData" });
    expect(classifyFileName("series.pvd")).toEqual({ kind: "collection", ext: ".pvd" });
    expect(classifyFileName("run.case")).toEqual({ kind: "server", ext: ".case" });
    expect(classifyFileName("notes.txt")).toEqual({ kind: "unknown", ext: ".txt" });
    expect(classifyFileName("noext")).toEqual({ kind: "unknown", ext: "" });
  });
});

describe("parsePvdCollection", () => {
  it("sorts steps by time and keeps one part per step", () => {
    const { steps, skippedParts } = parsePvdCollection(PVD);
    expect(steps).toEqual([
      { time: 0, file: "sub/step0.vtp" },
      { time: 1.5, file: "step1.vtp" },
    ]);
    expect(skippedParts).toBe(1);
  });

  it("rejects malformed or non-collection XML", () => {
    expect(() => parsePvdCollection("<VTKFile type=\"PolyData\"/>")).toThrow(LocalDatasetError);
    expect(() => parsePvdCollection("not xml <")).toThrow(LocalDatasetError);
    expect(() => parsePvdCollection("<VTKFile type=\"Collection\"><Collection/></VTKFile>"))
      .toThrow(LocalDatasetError);
  });
});

describe("resolveReferencedFile", () => {
  it("matches relative paths against the descriptor's folder, then basenames", () => {
    const step = file("step0.vtp", "x", "run/sub/step0.vtp");
    const other = file("step1.vtp", "x", "run/step1.vtp");
    expect(resolveReferencedFile("run/series.pvd", "sub/step0.vtp", [step, other])).toBe(step);
    expect(resolveReferencedFile("run/series.pvd", "./step1.vtp", [step, other])).toBe(other);
    expect(resolveReferencedFile("series.pvd", "step0.vtp", [step])).toBe(step);
    expect(resolveReferencedFile("series.pvd", "missing.vtp", [step])).toBeNull();
  });
});

describe("csvColumnInfo", () => {
  it("marks numeric and string columns from the header and sample rows", () => {
    const columns = csvColumnInfo("﻿x,y,label\n1,2,a\n3,4,b\n");
    expect(columns.map((column) => [column.name, column.data_type])).toEqual([
      ["x", "numeric"], ["y", "numeric"], ["label", "string"],
    ]);
    expect(columns[0].association).toBe("table");
    expect(() => csvColumnInfo("")).toThrow(LocalDatasetError);
  });
});

describe("readCsvHead", () => {
  it("returns small files whole and trims a large file to complete rows", async () => {
    const small = new Blob(["x,y\n1,2"]);
    expect(await readCsvHead(small)).toBe("x,y\n1,2");
    const row = "1,2,3\n";
    const large = new Blob(["x,y,z\n", row.repeat(Math.ceil(CSV_SAMPLE_BYTES / row.length) + 10)]);
    const head = await readCsvHead(large);
    expect(head.length).toBeLessThanOrEqual(CSV_SAMPLE_BYTES);
    expect(head.endsWith("\n")).toBe(true);
    expect(head.startsWith("x,y,z\n")).toBe(true);
  });
});

describe("createLocalDataset", () => {
  it("builds a ready dataset with a blob URL for a single browser file", async () => {
    const source = await createLocalDataset([file("mesh.vtp")], { ...urlOptions, id: "local:1" });
    expect(source.dataset).toMatchObject({
      id: "local:1",
      project_id: "local",
      filename: "mesh.vtp",
      ext: ".vtp",
      status: "ready",
      dataset_type: "PolyData",
    });
    expect(source.urls).toEqual(["blob:mesh.vtp"]);
    expect(localDatasetUrl(source.dataset)).toBe("blob:mesh.vtp");
    expect(isLocalDataset(source.dataset)).toBe(true);
    expect(isLocalDatasetId("local:1")).toBe(true);
    expect(isLocalDatasetId("d1")).toBe(false);
  });

  it("extracts CSV columns so coordinates can be chosen before rendering", async () => {
    const source = await createLocalDataset(
      [file("points.csv", "x,y,z,t\n0,0,0,1\n")],
      urlOptions,
    );
    expect(source.dataset.dataset_type).toBe("Table");
    expect(source.dataset.arrays?.map((array) => array.name)).toEqual(["x", "y", "z", "t"]);
  });

  it("explains server-only and unsupported formats", async () => {
    await expect(createLocalDataset([file("run.case")], urlOptions))
      .rejects.toMatchObject({ code: "server-only", details: ["run.case"] });
    await expect(createLocalDataset([file("notes.txt")], urlOptions))
      .rejects.toMatchObject({ code: "unsupported", details: [".txt"] });
    await expect(createLocalDataset([], urlOptions)).rejects.toMatchObject({ code: "no-files" });
    await expect(createLocalDataset([file("a.vtp"), file("b.vtp")], urlOptions))
      .rejects.toMatchObject({ code: "needs-descriptor" });
  });

  it("resolves a PVD folder into ordered timestep URLs", async () => {
    const files = [
      file("series.pvd", PVD, "run/series.pvd"),
      file("step0.vtp", "x", "run/sub/step0.vtp"),
      file("step0_part1.vtp", "x", "run/sub/step0_part1.vtp"),
      file("step1.vtp", "x", "run/step1.vtp"),
    ];
    const source = await createLocalDataset(files, urlOptions);
    expect(source.dataset.dataset_type).toBe("Collection");
    expect(source.dataset.timesteps).toEqual([0, 1.5]);
    expect(source.urls).toEqual(["blob:step0.vtp", "blob:step1.vtp"]);
    expect(source.dataset.extra).toMatchObject({
      inner_type: "PolyData", bundle_complete: true, skipped_parts: 1,
    });
    expect(localDatasetUrl(source.dataset, 1)).toBe("blob:step1.vtp");
    expect(localDatasetUrl(source.dataset, 99)).toBe("blob:step1.vtp");
  });

  it("lists the missing files of an incomplete PVD selection", async () => {
    await expect(createLocalDataset([file("series.pvd", PVD)], urlOptions))
      .rejects.toMatchObject({ code: "missing-files", details: ["sub/step0.vtp", "step1.vtp"] });
  });

  it("revokes every URL on release", async () => {
    const revoked: string[] = [];
    const source = await createLocalDataset(
      [file("series.pvd", PVD), file("step0.vtp"), file("step1.vtp")],
      { ...urlOptions, revokeObjectUrl: (url) => revoked.push(url) },
    );
    source.revoke();
    expect(revoked).toEqual(["blob:step0.vtp", "blob:step1.vtp"]);
  });
});

describe("withSceneSummary", () => {
  it("replaces metadata for geometry and keeps CSV columns", () => {
    const summary = {
      num_points: 4,
      num_cells: 2,
      bounds: [0, 1, 0, 1, 0, 1],
      arrays: [{ name: "t", association: "point" as const, num_components: 1, value_range: [1, 2] as [number, number] }],
    };
    const geometry = withSceneSummary({
      id: "local:1", project_id: "local", filename: "m.vtp", ext: ".vtp", size_bytes: 1,
      status: "ready", dataset_type: "PolyData", created_at: "", extra: { local: true },
    }, summary);
    expect(geometry.num_points).toBe(4);
    expect(geometry.arrays).toEqual(summary.arrays);
    const table = withSceneSummary({
      id: "local:2", project_id: "local", filename: "p.csv", ext: ".csv", size_bytes: 1,
      status: "ready", dataset_type: "Table", created_at: "",
      arrays: [{ name: "t", association: "table", num_components: 1, data_type: "numeric" }],
    }, summary);
    expect(table.arrays).toEqual([
      { name: "t", association: "table", num_components: 1, data_type: "numeric", value_range: [1, 2] },
    ]);
  });
});
