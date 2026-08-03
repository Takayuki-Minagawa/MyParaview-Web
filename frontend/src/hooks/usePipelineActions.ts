import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Dataset, Job, Pipeline, ViewState } from "../types";
import { customColorMapDefinition } from "../lib/colormap";
import { parseViewState } from "../lib/viewState";
import type { DisplayState } from "./useDisplayState";
import type { ProjectScope, ScopeTicket } from "./useProjectScope";

interface Options {
  scope: ProjectScope;
  display: DisplayState;
  selectedDataset: Dataset | null;
  selectDataset: (id: string) => Promise<Dataset | null>;
  setPipelines: Dispatch<SetStateAction<Pipeline[]>>;
  trackJob: (job: Job, ticket?: ScopeTicket | null) => Promise<Job>;
  onError: (message: string) => void;
  /** Localized message for a stored pipeline whose state cannot be restored. */
  unreadableText: string;
}

/** Save/restore/delete/rename/run actions for stored view pipelines. */
export function usePipelineActions({
  scope,
  display,
  selectedDataset,
  selectDataset,
  setPipelines,
  trackJob,
  onError,
  unreadableText,
}: Options) {
  const savePipeline = useCallback(async (name: string) => {
    const ticket = scope.capture();
    if (!ticket || !selectedDataset) return;
    const customColorMap = customColorMapDefinition(display.colorMap);
    const state: ViewState = {
      schema_version: 1,
      representation: display.representation,
      color_by: display.colorBy,
      color_range: display.customColorRange,
      opacity: display.opacity,
      color_map: display.colorMap,
      ...(customColorMap ? { custom_color_map: customColorMap } : {}),
      legend_visible: display.legendVisible,
      camera: display.cameraState,
      table_coordinates: display.tableCoordinates,
      image_mode: display.imageMode,
      slice_axis: display.sliceAxis,
      slice_index: display.sliceIndex,
      timestep_index: display.timestepIndex,
      volume_opacity_points: display.volumeOpacityPoints,
    };
    try {
      const created = await api.createViewPipeline(
        ticket.projectId, selectedDataset.id, name, state,
      );
      if (ticket.stillCurrent()) {
        setPipelines((previous) => [created, ...previous]);
      }
    } catch (e) {
      if (ticket.stillCurrent()) onError(String(e));
    }
  }, [scope, selectedDataset, display, setPipelines, onError]);

  const restorePipeline = useCallback(async (pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    const nodes = pipeline.nodes ?? [];
    const representationNode = nodes.find((node) => node.node_type === "representation");
    const state = parseViewState(representationNode?.params.view_state);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let input = representationNode;
    const visited = new Set<string>();
    while (input?.input_id && !visited.has(input.input_id)) {
      visited.add(input.input_id);
      input = byId.get(input.input_id);
      if (input?.node_type === "reader") break;
    }
    if (!input?.dataset_id || input.node_type !== "reader" || !state) {
      onError(unreadableText);
      return;
    }
    const dataset = await selectDataset(input.dataset_id);
    if (!dataset || !ticket.stillCurrent()) return;
    display.restoreViewState(state);
  }, [scope, onError, unreadableText, selectDataset, display]);

  const deletePipeline = useCallback((pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void api.deletePipeline(pipeline.id)
      .then(() => {
        if (ticket.stillCurrent()) {
          setPipelines((previous) => previous.filter((item) => item.id !== pipeline.id));
        }
      })
      .catch((e) => {
        if (ticket.stillCurrent()) onError(String(e));
      });
  }, [scope, setPipelines, onError]);

  const renamePipeline = useCallback((pipeline: Pipeline, name: string) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void api.renamePipeline(pipeline.id, name)
      .then((updated) => {
        if (ticket.stillCurrent()) {
          setPipelines((previous) =>
            previous.map((item) => (item.id === updated.id ? updated : item)),
          );
        }
      })
      .catch((e) => {
        if (ticket.stillCurrent()) onError(String(e));
      });
  }, [scope, setPipelines, onError]);

  const runPipeline = useCallback((pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void (async () => {
      try {
        const job = await api.runPipeline(pipeline.id);
        await trackJob(job, ticket);
      } catch (e) {
        if (ticket.stillCurrent()) onError(String(e));
      }
    })();
  }, [scope, trackJob, onError]);

  return { savePipeline, restorePipeline, deletePipeline, renamePipeline, runPipeline };
}
