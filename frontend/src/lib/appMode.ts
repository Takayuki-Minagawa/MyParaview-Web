/** Application mode resolution.
 *
 * `static` serves the browser-only viewer (GitHub Pages and other static
 * hosts): no API request is made until the user explicitly connects to a
 * server. `server` keeps the historical behaviour of talking to a FastAPI
 * backend at start-up.
 *
 * The production default is `static` so a build without an explicit API base
 * never probes `http://localhost:8000` on a visitor's machine. The Vite dev
 * server keeps `server` as its default so `npm run dev` with a local backend
 * works unchanged.
 */
export type AppMode = "static" | "server";

export interface ConnectionConfig {
  mode: AppMode;
  /** API base URL for server mode; null in static mode. */
  apiBase: string | null;
  /** Whether the app should connect at start-up without a user action. */
  autoConnect: boolean;
  /** Where the configuration came from, for diagnostics. */
  source: "env-static" | "env-api-base" | "env-server" | "dev-default" | "static-default";
}

export interface ModeEnvironment {
  VITE_APP_MODE?: string;
  VITE_API_BASE?: string;
  DEV?: boolean;
}

export const DEV_API_BASE = "http://localhost:8000";
export const API_BASE_STORAGE_KEY = "pvweb-api-base";

export function resolveConnectionConfig(env: ModeEnvironment): ConnectionConfig {
  const mode = (env.VITE_APP_MODE ?? "").trim().toLowerCase();
  const apiBase = (env.VITE_API_BASE ?? "").trim();
  if (mode === "static") {
    return { mode: "static", apiBase: null, autoConnect: false, source: "env-static" };
  }
  if (apiBase) {
    return {
      mode: "server",
      apiBase: normalizeApiBase(apiBase) ?? apiBase,
      autoConnect: true,
      source: "env-api-base",
    };
  }
  if (mode === "server") {
    return { mode: "server", apiBase: DEV_API_BASE, autoConnect: true, source: "env-server" };
  }
  if (env.DEV) {
    return { mode: "server", apiBase: DEV_API_BASE, autoConnect: true, source: "dev-default" };
  }
  return { mode: "static", apiBase: null, autoConnect: false, source: "static-default" };
}

/** Accept absolute http(s) URLs and root-relative paths such as `/api`.
 * Returns the trimmed value without a trailing slash, or null when invalid. */
export function normalizeApiBase(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/\/+$/, "") || "/";
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, "");
}

/** Browser-facing resolution: environment first, then the user's last
 * explicit connection target as a non-auto-connecting suggestion. */
export function readStoredApiBase(storage: Pick<Storage, "getItem"> | null): string | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(API_BASE_STORAGE_KEY);
    return stored ? normalizeApiBase(stored) : null;
  } catch {
    return null;
  }
}

export function writeStoredApiBase(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  apiBase: string | null,
): void {
  if (!storage) return;
  try {
    if (apiBase) storage.setItem(API_BASE_STORAGE_KEY, apiBase);
    else storage.removeItem(API_BASE_STORAGE_KEY);
  } catch {
    /* storage may be unavailable in private windows */
  }
}

/** Translate a raw fetch failure into a reason code the UI can explain. */
export type ConnectionFailureKind = "unreachable" | "http" | "timeout" | "invalid-url" | "unknown";

export function classifyConnectionError(error: unknown): ConnectionFailureKind {
  if (error && typeof error === "object" && "status" in error) return "http";
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "timeout";
  }
  const message = String(error instanceof Error ? error.message : error);
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return "unreachable";
  }
  return "unknown";
}
