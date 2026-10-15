import { afterEach, describe, expect, it } from "vitest";
import { setApiBase } from "../api";
import type { Dataset } from "../types";
import { viewerUrlFor } from "./datasetUrl";

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1", project_id: "p1", filename: "m.vtp", ext: ".vtp", size_bytes: 1,
    status: "ready", dataset_type: "PolyData", created_at: "", ...overrides,
  };
}

describe("viewerUrlFor", () => {
  afterEach(() => setApiBase(null));

  it("returns null instead of throwing for server datasets without a connection", () => {
    setApiBase(null);
    expect(viewerUrlFor(dataset(), 0)).toBeNull();
    expect(viewerUrlFor(dataset({ dataset_type: "Collection" }), 1)).toBeNull();
  });

  it("builds server URLs while connected and blob URLs for local datasets", () => {
    setApiBase("https://api.example.com/");
    expect(viewerUrlFor(dataset(), 0)).toBe("https://api.example.com/datasets/d1/download");
    expect(viewerUrlFor(dataset({ dataset_type: "Collection" }), 2))
      .toBe("https://api.example.com/datasets/d1/timesteps/2/download");
    expect(viewerUrlFor(dataset({ dataset_type: "Collection", extra: { bundle_complete: false } }), 0))
      .toBeNull();
    expect(viewerUrlFor(dataset({ status: "ingesting" }), 0)).toBeNull();
    setApiBase(null);
    expect(viewerUrlFor(dataset({
      id: "local:1", extra: { local: true, local_urls: ["blob:a"] },
    }), 0)).toBe("blob:a");
    expect(viewerUrlFor(null, 0)).toBeNull();
  });
});
