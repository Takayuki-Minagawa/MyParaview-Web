import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getApiBase, setApiBase } from "../api";
import type { ServerCapabilities } from "../types";
import {
  classifyConnectionError,
  normalizeApiBase,
  readStoredApiBase,
  resolveConnectionConfig,
  writeStoredApiBase,
  type AppMode,
  type ConnectionConfig,
  type ConnectionFailureKind,
} from "../lib/appMode";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface ConnectionFailure {
  kind: ConnectionFailureKind;
  /** Raw error text for diagnostics; the UI shows a translated explanation. */
  detail: string;
}

export interface ServerConnection {
  config: ConnectionConfig;
  mode: AppMode;
  apiBase: string | null;
  status: ConnectionStatus;
  failure: ConnectionFailure | null;
  capabilities: ServerCapabilities | null;
  /** Last target the user connected to, offered as the form default. */
  suggestedApiBase: string;
  /** Increments on every successful connection so dependents refetch. */
  epoch: number;
  connect: (apiBase: string) => Promise<boolean>;
  retry: () => Promise<boolean>;
  disconnect: () => void;
}

const HEALTH_TIMEOUT_MS = 10_000;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Owns the server connection lifecycle. In static mode nothing is contacted
 * until `connect` is called by an explicit user action. */
export function useServerConnection(): ServerConnection {
  const config = useMemo(() => resolveConnectionConfig({
    VITE_APP_MODE: import.meta.env?.VITE_APP_MODE as string | undefined,
    VITE_API_BASE: import.meta.env?.VITE_API_BASE as string | undefined,
    DEV: Boolean(import.meta.env?.DEV),
  }), []);
  const [mode, setMode] = useState<AppMode>(config.mode);
  const [apiBase, setApiBaseState] = useState<string | null>(config.apiBase);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [failure, setFailure] = useState<ConnectionFailure | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [suggestedApiBase, setSuggestedApiBase] = useState<string>(
    () => config.apiBase ?? readStoredApiBase(storage()) ?? "",
  );
  const attemptRef = useRef(0);

  const connect = useCallback(async (target: string): Promise<boolean> => {
    const normalized = normalizeApiBase(target);
    const attempt = ++attemptRef.current;
    if (!normalized) {
      setStatus("failed");
      setFailure({ kind: "invalid-url", detail: target });
      return false;
    }
    setApiBase(normalized);
    setApiBaseState(normalized);
    setSuggestedApiBase(normalized);
    setMode("server");
    setStatus("connecting");
    setFailure(null);
    try {
      await api.health({ signal: timeoutSignal(HEALTH_TIMEOUT_MS) });
      if (attempt !== attemptRef.current) return false;
      const nextCapabilities = await api.capabilities().catch(() => null);
      if (attempt !== attemptRef.current) return false;
      setCapabilities(nextCapabilities);
      setStatus("connected");
      setEpoch((value) => value + 1);
      writeStoredApiBase(storage(), normalized);
      return true;
    } catch (error) {
      if (attempt !== attemptRef.current) return false;
      setCapabilities(null);
      setStatus("failed");
      setFailure({ kind: classifyConnectionError(error), detail: String(error) });
      return false;
    }
  }, []);

  const retry = useCallback(() => {
    const target = apiBase ?? getApiBase() ?? suggestedApiBase;
    return connect(target);
  }, [apiBase, suggestedApiBase, connect]);

  const disconnect = useCallback(() => {
    attemptRef.current += 1;
    setApiBase(null);
    setApiBaseState(null);
    setMode("static");
    setStatus("disconnected");
    setFailure(null);
    setCapabilities(null);
  }, []);

  useEffect(() => {
    if (config.autoConnect && config.apiBase) void connect(config.apiBase);
    // Start-up only; the config is fixed for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(() => ({
    config, mode, apiBase, status, failure, capabilities, suggestedApiBase, epoch,
    connect, retry, disconnect,
  }), [
    config, mode, apiBase, status, failure, capabilities, suggestedApiBase, epoch,
    connect, retry, disconnect,
  ]);
}
