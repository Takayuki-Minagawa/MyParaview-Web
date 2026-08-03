import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authorizedFetch, pollJob } from "./api";
import type { Job } from "./types";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function jobWith(status: Job["status"]): Job {
  return {
    id: "j1",
    kind: "filter",
    status,
    progress: 0,
    log: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
});

describe("req error handling", () => {
  it("throws an Error containing status and body text on non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("dataset gone", { status: 404, statusText: "Not Found" }),
      ),
    );
    await expect(api.getDataset("d1")).rejects.toThrow("404 Not Found: dataset gone");
  });

  it("still reports the status when the body cannot be read", async () => {
    const broken = new Response(null, { status: 500, statusText: "Server Error" });
    vi.spyOn(broken, "text").mockRejectedValue(new Error("stream error"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(broken));
    await expect(api.health()).rejects.toThrow("500 Server Error: ");
  });
});

describe("authorizedFetch", () => {
  it("attaches the Authorization header when sessionStorage holds pvweb.accessToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const getItem = vi.fn((key: string) => (key === "pvweb.accessToken" ? "tok-123" : null));
    vi.stubGlobal("window", { sessionStorage: { getItem } });

    await authorizedFetch("http://example.test/thing");

    expect(getItem).toHaveBeenCalledWith("pvweb.accessToken");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null } });

    await authorizedFetch("http://example.test/thing", { headers: { "X-Extra": "1" } });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Extra")).toBe("1");
  });
});

describe("pollJob", () => {
  it("resolves on a terminal status and calls onTick once per poll", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(jobWith("running")))
      .mockResolvedValueOnce(jsonResponse(jobWith("succeeded")));
    vi.stubGlobal("fetch", fetchMock);
    const onTick = vi.fn();

    const promise = pollJob("j1", onTick, { intervalMs: 10, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(50);
    const job = await promise;

    expect(job.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect((onTick.mock.calls[0][0] as Job).status).toBe("running");
    expect((onTick.mock.calls[1][0] as Job).status).toBe("succeeded");
  });

  it("throws once the deadline passes without a terminal status", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(jobWith("running")))),
    );

    const promise = pollJob("j1", undefined, { intervalMs: 10, timeoutMs: 25 });
    const rejection = expect(promise).rejects.toThrow(/job j1 timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });
});

describe("createJob", () => {
  it("preserves the typed server-filter parameter contract in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(jobWith("queued")));
    vi.stubGlobal("fetch", fetchMock);

    await api.createJob("p1", "filter", "d1", {
      filter: "resample",
      dimensions: [16, 24, 32],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/jobs$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      project_id: "p1",
      kind: "filter",
      target_id: "d1",
      params: { filter: "resample", dimensions: [16, 24, 32] },
    });
  });

  it("sends the strict movie export contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(jobWith("queued")));
    vi.stubGlobal("fetch", fetchMock);

    await api.createMovieJob("p1", "d1", {
      format: "mp4",
      fps: 24,
      width: 1280,
      height: 720,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/jobs$/);
    expect(JSON.parse(String(init.body))).toEqual({
      project_id: "p1",
      kind: "movie",
      target_id: "d1",
      params: { format: "mp4", fps: 24, width: 1280, height: 720 },
    });
  });
});

describe("sessionWebSocketUrl", () => {
  it("converts an https API base to wss", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.example.com");
    vi.resetModules();
    const fresh = await import("./api");
    expect(fresh.api.sessionWebSocketUrl("/sessions/s1/ws")).toBe(
      "wss://api.example.com/sessions/s1/ws",
    );
  });

  it("converts an http API base to ws", async () => {
    vi.stubEnv("VITE_API_BASE", "http://localhost:8000");
    vi.resetModules();
    const fresh = await import("./api");
    expect(fresh.api.sessionWebSocketUrl("/ws")).toBe("ws://localhost:8000/ws");
  });
});
