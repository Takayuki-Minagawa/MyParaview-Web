import { describe, expect, it } from "vitest";
import {
  classifyConnectionError,
  normalizeApiBase,
  readStoredApiBase,
  resolveConnectionConfig,
  writeStoredApiBase,
  API_BASE_STORAGE_KEY,
  DEV_API_BASE,
} from "./appMode";

describe("resolveConnectionConfig", () => {
  it("defaults a production build without an API base to static mode", () => {
    const config = resolveConnectionConfig({});
    expect(config.mode).toBe("static");
    expect(config.apiBase).toBeNull();
    expect(config.autoConnect).toBe(false);
    expect(config.source).toBe("static-default");
  });

  it("keeps the dev server on the local backend", () => {
    const config = resolveConnectionConfig({ DEV: true });
    expect(config).toMatchObject({ mode: "server", apiBase: DEV_API_BASE, autoConnect: true });
  });

  it("honours an explicit API base and normalizes a trailing slash", () => {
    const config = resolveConnectionConfig({ VITE_API_BASE: "https://api.example.com/" });
    expect(config).toMatchObject({
      mode: "server",
      apiBase: "https://api.example.com",
      autoConnect: true,
      source: "env-api-base",
    });
  });

  it("forces static mode even when the dev server is running", () => {
    const config = resolveConnectionConfig({ VITE_APP_MODE: "static", DEV: true });
    expect(config.mode).toBe("static");
    expect(config.apiBase).toBeNull();
  });

  it("uses the dev base for server mode without an API base", () => {
    expect(resolveConnectionConfig({ VITE_APP_MODE: "server" }).apiBase).toBe(DEV_API_BASE);
  });
});

describe("normalizeApiBase", () => {
  it("accepts http(s) URLs and root-relative paths", () => {
    expect(normalizeApiBase(" http://localhost:8000/ ")).toBe("http://localhost:8000");
    expect(normalizeApiBase("https://example.com/api/")).toBe("https://example.com/api");
    expect(normalizeApiBase("/api/")).toBe("/api");
  });

  it("rejects other schemes, queries, and junk", () => {
    expect(normalizeApiBase("ftp://example.com")).toBeNull();
    expect(normalizeApiBase("http://example.com/?x=1")).toBeNull();
    expect(normalizeApiBase("not a url")).toBeNull();
    expect(normalizeApiBase("")).toBeNull();
  });
});

describe("stored API base", () => {
  it("round-trips through storage and ignores invalid values", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    writeStoredApiBase(storage, "http://localhost:8000/");
    expect(store.get(API_BASE_STORAGE_KEY)).toBe("http://localhost:8000/");
    expect(readStoredApiBase(storage)).toBe("http://localhost:8000");
    store.set(API_BASE_STORAGE_KEY, "garbage");
    expect(readStoredApiBase(storage)).toBeNull();
    writeStoredApiBase(storage, null);
    expect(store.has(API_BASE_STORAGE_KEY)).toBe(false);
    expect(readStoredApiBase(null)).toBeNull();
  });
});

describe("classifyConnectionError", () => {
  it("recognizes network failures, HTTP errors, and timeouts", () => {
    expect(classifyConnectionError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(classifyConnectionError({ status: 503, message: "x" })).toBe("http");
    expect(classifyConnectionError(new DOMException("t", "TimeoutError"))).toBe("timeout");
    expect(classifyConnectionError(new Error("something else"))).toBe("unknown");
  });
});
