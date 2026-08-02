import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Dataset, Pipeline, ViewState } from "../types";
import type { DisplayState } from "./useDisplayState";
import type { ProjectScope } from "./useProjectScope";
import { usePipelineActions } from "./usePipelineActions";

const VIEW_STATE: ViewState = {
  schema_version: 1,
  representation: "wireframe",
  color_by: { name: "Temperature", association: "point" },
  color_range: [0, 100],
  opacity: 0.5,
  color_map: "viridis",
  legend_visible: false,
  camera: null,
};

const PIPELINE: Pipeline = {
  id: "pipeline-1",
  project_id: "project-1",
  name: "Saved view",
  created_at: "2026-08-02T00:00:00Z",
  nodes: [
    {
      id: "reader-1",
      pipeline_id: "pipeline-1",
      node_type: "reader",
      name: "Reader",
      params: {},
      dataset_id: "dataset-1",
    },
    {
      id: "representation-1",
      pipeline_id: "pipeline-1",
      node_type: "representation",
      name: "Representation",
      params: { view_state: VIEW_STATE },
      input_id: "reader-1",
    },
  ],
};

function scope(stillCurrent = true): ProjectScope {
  return {
    capture: () => ({ projectId: "project-1", stillCurrent: () => stillCurrent }),
  } as ProjectScope;
}

describe("usePipelineActions ViewState restore", () => {
  it("routes a saved ViewState through the atomic display history operation", async () => {
    const restoreViewState = vi.fn();
    const selectDataset = vi.fn().mockResolvedValue({
      id: "dataset-1",
      project_id: "project-1",
    } as Dataset);
    const { result } = renderHook(() => usePipelineActions({
      scope: scope(),
      display: { restoreViewState } as unknown as DisplayState,
      selectedDataset: null,
      selectDataset,
      setPipelines: vi.fn(),
      trackJob: vi.fn(),
      onError: vi.fn(),
      unreadableText: "Unreadable",
    }));

    await act(async () => result.current.restorePipeline(PIPELINE));

    expect(selectDataset).toHaveBeenCalledWith("dataset-1");
    expect(restoreViewState).toHaveBeenCalledTimes(1);
    expect(restoreViewState).toHaveBeenCalledWith(VIEW_STATE);
  });

  it("does not restore after the project scope becomes stale", async () => {
    const restoreViewState = vi.fn();
    const { result } = renderHook(() => usePipelineActions({
      scope: scope(false),
      display: { restoreViewState } as unknown as DisplayState,
      selectedDataset: null,
      selectDataset: vi.fn().mockResolvedValue({ id: "dataset-1" } as Dataset),
      setPipelines: vi.fn(),
      trackJob: vi.fn(),
      onError: vi.fn(),
      unreadableText: "Unreadable",
    }));

    await act(async () => result.current.restorePipeline(PIPELINE));
    expect(restoreViewState).not.toHaveBeenCalled();
  });
});
