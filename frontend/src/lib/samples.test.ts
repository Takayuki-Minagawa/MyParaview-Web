// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fetchSampleFiles, loadSample, sampleById, sampleUrl, SAMPLES } from "./samples";

describe("sample catalog", () => {
  it("builds same-origin sample URLs under the app base path", () => {
    expect(sampleUrl("/MyParaview-Web/", "a.vtp")).toBe("/MyParaview-Web/samples/a.vtp");
    expect(sampleUrl("/", "a.vtp")).toBe("/samples/a.vtp");
    expect(sampleUrl("/x", "a.vtp")).toBe("/x/samples/a.vtp");
  });

  it("includes failure demonstrations alongside the normal samples", () => {
    expect(SAMPLES.map((sample) => sample.expectation)).toEqual(expect.arrayContaining([
      "ok", "broken", "server-only", "missing-files",
    ]));
    expect(sampleById("series")?.files).toHaveLength(5);
    expect(sampleById("nope")).toBeUndefined();
  });

  it("fetches each sample file as a File and reports HTTP failures", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const name = String(url).split("/").pop();
      return name === "missing_series.pvd"
        ? new Response("gone", { status: 404, statusText: "Not Found" })
        : new Response(`<${name}>`, { status: 200 });
    }) as unknown as typeof fetch;
    const files = await fetchSampleFiles(sampleById("surface")!, "/", fetchImpl);
    expect(files[0].name).toBe("wave_surface.vtp");
    expect(await files[0].text()).toBe("<wave_surface.vtp>");
    await expect(fetchSampleFiles(sampleById("missingFiles")!, "/", fetchImpl))
      .rejects.toThrow(/404/);
  });

  it("turns a server-only sample into the matching local dataset error", async () => {
    const fetchImpl = vi.fn(async () => new Response("FORMAT", { status: 200 })) as unknown as typeof fetch;
    await expect(loadSample(sampleById("serverOnly")!, "/", "label", fetchImpl))
      .rejects.toMatchObject({ code: "server-only" });
  });
});
