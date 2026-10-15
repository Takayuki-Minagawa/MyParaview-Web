import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, getApiBase, setApiBase } from "../api";
import { API_BASE_STORAGE_KEY } from "../lib/appMode";
import { useServerConnection } from "./useServerConnection";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    api: {
      ...original.api,
      health: vi.fn(),
      capabilities: vi.fn(),
    },
  };
});

const health = vi.mocked(api.health);
const capabilities = vi.mocked(api.capabilities);

describe("useServerConnection", () => {
  beforeEach(() => {
    health.mockReset();
    capabilities.mockReset();
    window.localStorage.clear();
    vi.stubEnv("VITE_APP_MODE", "static");
    setApiBase(null);
  });

  it("stays static and silent until the user connects", async () => {
    const { result } = renderHook(() => useServerConnection());
    expect(result.current.mode).toBe("static");
    expect(result.current.status).toBe("disconnected");
    expect(health).not.toHaveBeenCalled();
    health.mockResolvedValue({ status: "ok" });
    capabilities.mockResolvedValue({
      database: "sqlite", object_store: "local", oidc: false, paraview_worker: false,
      video_export: false, job_queue: "local", trame_sessions: false,
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.connect("http://localhost:8000/");
    });
    expect(ok).toBe(true);
    expect(result.current.mode).toBe("server");
    expect(result.current.status).toBe("connected");
    expect(result.current.apiBase).toBe("http://localhost:8000");
    expect(getApiBase()).toBe("http://localhost:8000");
    expect(result.current.epoch).toBe(1);
    expect(result.current.capabilities?.database).toBe("sqlite");
    expect(window.localStorage.getItem(API_BASE_STORAGE_KEY)).toBe("http://localhost:8000");
    act(() => result.current.disconnect());
    expect(result.current.mode).toBe("static");
    expect(getApiBase()).toBeNull();
  });

  it("classifies an unreachable server and retries the same target", async () => {
    health.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useServerConnection());
    await act(async () => {
      await result.current.connect("http://localhost:8000");
    });
    expect(result.current.status).toBe("failed");
    expect(result.current.failure).toEqual({
      kind: "unreachable", detail: "TypeError: Failed to fetch",
    });
    expect(window.localStorage.getItem(API_BASE_STORAGE_KEY)).toBeNull();
    health.mockResolvedValue({ status: "ok" });
    capabilities.mockRejectedValue(new Error("no capabilities"));
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.capabilities).toBeNull();
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ signal: expect.anything() }));
  });

  it("keeps a working connection when the form receives an invalid URL", async () => {
    health.mockResolvedValue({ status: "ok" });
    capabilities.mockResolvedValue(null as never);
    const { result } = renderHook(() => useServerConnection());
    await act(async () => {
      await result.current.connect("http://localhost:8000");
    });
    expect(result.current.status).toBe("connected");
    await act(async () => {
      await result.current.connect("localhost:8000");
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.failure?.kind).toBe("invalid-url");
    expect(result.current.apiBase).toBe("http://localhost:8000");
    expect(getApiBase()).toBe("http://localhost:8000");
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid URL without touching the network", async () => {
    const { result } = renderHook(() => useServerConnection());
    await act(async () => {
      await result.current.connect("ftp://nope");
    });
    expect(result.current.status).toBe("failed");
    expect(result.current.failure?.kind).toBe("invalid-url");
    expect(health).not.toHaveBeenCalled();
  });
});
