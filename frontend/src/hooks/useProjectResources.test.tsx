import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProjectResources } from "./useProjectResources";
import { useProjectScope } from "./useProjectScope";
import { api } from "../api";
import type { Artifact, Dataset, Pipeline, ProjectMember } from "../types";

vi.mock("../api", () => ({
  api: {
    listDatasets: vi.fn(),
    listPipelines: vi.fn(),
    getMembership: vi.fn(),
    listMembers: vi.fn(),
    listArtifacts: vi.fn(),
  },
}));

const listDatasets = vi.mocked(api.listDatasets);
const listPipelines = vi.mocked(api.listPipelines);
const getMembership = vi.mocked(api.getMembership);
const listMembers = vi.mocked(api.listMembers);
const listArtifacts = vi.mocked(api.listArtifacts);

const PREFIXES = {
  dataset: "datasets",
  pipeline: "pipelines",
  member: "members",
  artifact: "artifacts",
};

function dataset(id: string): Dataset {
  return { id, project_id: "p1", filename: `${id}.vtp`, ext: ".vtp", status: "ready" } as Dataset;
}

function member(role: ProjectMember["role"]): ProjectMember {
  return { project_id: "p1", user_id: "u1", role } as ProjectMember;
}

function renderResources(projectId: string | null = "p1") {
  const onError = vi.fn();
  const onErrorCleared = vi.fn();
  const rendered = renderHook(() => {
    const scope = useProjectScope();
    const resources = useProjectResources({
      scope,
      prefixes: PREFIXES,
      onError,
      onErrorCleared,
    });
    return { scope, resources };
  });
  if (projectId) {
    act(() => rendered.result.current.scope.beginProjectSwitch(projectId));
  }
  return { ...rendered, onError, onErrorCleared };
}

describe("useProjectResources", () => {
  beforeEach(() => {
    listDatasets.mockReset();
    listPipelines.mockReset();
    getMembership.mockReset();
    listMembers.mockReset();
    listArtifacts.mockReset();
  });

  it("refreshDatasets stores the list and clears the error banner", async () => {
    listDatasets.mockResolvedValue([dataset("d1")]);
    const { result, onErrorCleared } = renderResources();
    await act(async () => {
      await result.current.resources.refreshDatasets("p1");
    });
    expect(result.current.resources.datasets.map((d) => d.id)).toEqual(["d1"]);
    expect(onErrorCleared).toHaveBeenCalledWith("datasets");
  });

  it("ignores a dataset response that resolves after a project switch", async () => {
    let resolveList: (value: Dataset[]) => void = () => {};
    listDatasets.mockImplementation(
      () => new Promise<Dataset[]>((resolve) => { resolveList = resolve; }),
    );
    const { result } = renderResources();
    let pending: Promise<void>;
    act(() => {
      pending = result.current.resources.refreshDatasets("p1");
    });
    act(() => {
      result.current.scope.beginProjectSwitch("p2");
    });
    await act(async () => {
      resolveList([dataset("stale")]);
      await pending;
    });
    expect(result.current.resources.datasets).toEqual([]);
  });

  it("ignores a dataset refresh issued for a project other than the ticket's", async () => {
    listDatasets.mockResolvedValue([dataset("other")]);
    const { result } = renderResources("p1");
    await act(async () => {
      // Ticket captures p1 but the refresh argument targets p2: guarded.
      await result.current.resources.refreshDatasets("p2");
    });
    expect(result.current.resources.datasets).toEqual([]);
  });

  it("reports dataset errors with the prefix when still current", async () => {
    listDatasets.mockRejectedValue(new Error("boom"));
    const { result, onError } = renderResources();
    await act(async () => {
      await result.current.resources.refreshDatasets("p1");
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/^datasets: /);
  });

  it("refreshMembership loads members for admins only", async () => {
    getMembership.mockResolvedValue(member("admin"));
    listMembers.mockResolvedValue([member("admin"), member("viewer")]);
    const { result } = renderResources();
    await act(async () => {
      await result.current.resources.refreshMembership("p1");
    });
    expect(result.current.resources.membership?.role).toBe("admin");
    expect(result.current.resources.members).toHaveLength(2);

    getMembership.mockResolvedValue(member("viewer"));
    listMembers.mockClear();
    await act(async () => {
      await result.current.resources.refreshMembership("p1");
    });
    expect(result.current.resources.membership?.role).toBe("viewer");
    expect(result.current.resources.members).toEqual([]);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("refreshMembership failure clears membership and reports the error", async () => {
    getMembership.mockResolvedValue(member("admin"));
    listMembers.mockResolvedValue([member("admin")]);
    const { result, onError } = renderResources();
    await act(async () => {
      await result.current.resources.refreshMembership("p1");
    });
    expect(result.current.resources.membership).not.toBeNull();

    getMembership.mockRejectedValue(new Error("403"));
    await act(async () => {
      await result.current.resources.refreshMembership("p1");
    });
    expect(result.current.resources.membership).toBeNull();
    expect(result.current.resources.members).toEqual([]);
    expect(onError.mock.calls[onError.mock.calls.length - 1][0]).toMatch(/^members: /);
  });

  it("refreshArtifacts only applies while the same dataset stays selected", async () => {
    listArtifacts.mockResolvedValue([{ id: "a1" } as Artifact]);
    const { result } = renderResources();
    act(() => {
      result.current.scope.beginSelection("d1");
    });
    await act(async () => {
      await result.current.resources.refreshArtifacts("d1");
    });
    expect(result.current.resources.artifacts.map((a) => a.id)).toEqual(["a1"]);

    // A newer selection supersedes the in-flight refresh.
    let resolveList: (value: Artifact[]) => void = () => {};
    listArtifacts.mockImplementation(
      () => new Promise<Artifact[]>((resolve) => { resolveList = resolve; }),
    );
    let pending: Promise<void>;
    act(() => {
      pending = result.current.resources.refreshArtifacts("d1");
      result.current.scope.beginSelection("d2");
    });
    await act(async () => {
      resolveList([{ id: "stale" } as Artifact]);
      await pending;
    });
    expect(result.current.resources.artifacts.map((a) => a.id)).toEqual(["a1"]);
  });

  it("clearProjectResources resets every collection", async () => {
    listDatasets.mockResolvedValue([dataset("d1")]);
    listPipelines.mockResolvedValue([{ id: "pl1" } as Pipeline]);
    const { result } = renderResources();
    await act(async () => {
      await result.current.resources.refreshDatasets("p1");
      await result.current.resources.refreshPipelines("p1");
    });
    expect(result.current.resources.datasets).toHaveLength(1);
    expect(result.current.resources.pipelines).toHaveLength(1);

    act(() => {
      result.current.resources.clearProjectResources();
    });
    expect(result.current.resources.datasets).toEqual([]);
    expect(result.current.resources.pipelines).toEqual([]);
    expect(result.current.resources.membership).toBeNull();
    expect(result.current.resources.members).toEqual([]);
    expect(result.current.resources.artifacts).toEqual([]);
  });
});
