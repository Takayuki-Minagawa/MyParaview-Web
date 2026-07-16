import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRemoteSession } from "./useRemoteSession";
import { useProjectScope } from "./useProjectScope";
import { api } from "../api";
import type { RenderSessionCreated } from "../types";

vi.mock("../api", () => ({
  api: {
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

const createSession = vi.mocked(api.createSession);
const deleteSession = vi.mocked(api.deleteSession);

function session(id: string, datasetId = "d1"): RenderSessionCreated {
  return {
    id,
    dataset_id: datasetId,
    websocket_path: `/sessions/${id}/ws`,
    websocket_protocol: "pvweb.token",
  } as RenderSessionCreated;
}

function renderRemote() {
  const onError = vi.fn();
  const rendered = renderHook(() => {
    const scope = useProjectScope();
    const remote = useRemoteSession({ scope, onError });
    return { scope, remote };
  });
  act(() => {
    rendered.result.current.scope.beginProjectSwitch("p1");
    rendered.result.current.scope.beginSelection("d1");
  });
  return { ...rendered, onError };
}

describe("useRemoteSession", () => {
  beforeEach(() => {
    createSession.mockReset();
    deleteSession.mockReset();
    deleteSession.mockResolvedValue(undefined as never);
  });

  it("startRemote stores the created session", async () => {
    createSession.mockResolvedValue(session("s1"));
    const { result } = renderRemote();
    act(() => result.current.remote.startRemote());
    await waitFor(() => expect(result.current.remote.remoteSession?.id).toBe("s1"));
    expect(createSession).toHaveBeenCalledWith("p1", "d1");
  });

  it("startRemote tears the session down when the project changed meanwhile", async () => {
    let resolveCreate: (value: RenderSessionCreated) => void = () => {};
    createSession.mockImplementation(
      () => new Promise<RenderSessionCreated>((resolve) => { resolveCreate = resolve; }),
    );
    const { result } = renderRemote();
    act(() => result.current.remote.startRemote());
    act(() => result.current.scope.beginProjectSwitch("p2"));
    await act(async () => {
      resolveCreate(session("s1"));
      await Promise.resolve();
    });
    expect(result.current.remote.remoteSession).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("stopRemote deletes and clears the active session", async () => {
    createSession.mockResolvedValue(session("s1"));
    const { result } = renderRemote();
    act(() => result.current.remote.startRemote());
    await waitFor(() => expect(result.current.remote.remoteSession).not.toBeNull());

    act(() => result.current.remote.stopRemote());
    await waitFor(() => expect(result.current.remote.remoteSession).toBeNull());
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("stopIfDatasetChanged keeps the session for the same dataset only", async () => {
    createSession.mockResolvedValue(session("s1", "d1"));
    const { result } = renderRemote();
    act(() => result.current.remote.startRemote());
    await waitFor(() => expect(result.current.remote.remoteSession).not.toBeNull());

    act(() => result.current.remote.stopIfDatasetChanged("d1"));
    expect(result.current.remote.remoteSession?.id).toBe("s1");

    act(() => result.current.remote.stopIfDatasetChanged("d2"));
    expect(result.current.remote.remoteSession).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("clearOnProjectSwitch always drops the session", async () => {
    createSession.mockResolvedValue(session("s1"));
    const { result } = renderRemote();
    act(() => result.current.remote.startRemote());
    await waitFor(() => expect(result.current.remote.remoteSession).not.toBeNull());

    act(() => result.current.remote.clearOnProjectSwitch());
    expect(result.current.remote.remoteSession).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });
});
