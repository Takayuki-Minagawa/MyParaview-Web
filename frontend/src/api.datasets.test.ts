import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE, api } from "./api";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("dataset API", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("encodes non-empty dataset name and tag filters", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api.listDatasets("p1", { name: " heat result ", tag: " review " });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/projects/p1/datasets?name=heat+result&tag=review`,
    );
  });

  it("patches a dataset's tags as JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "d1", tags: ["review"] }));
    await api.updateDatasetTags("d1", ["review"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/datasets/d1/tags`);
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ tags: ["review"] }));
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });
});
