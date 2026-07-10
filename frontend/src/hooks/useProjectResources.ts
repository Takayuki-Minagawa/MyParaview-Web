import { useCallback, useState } from "react";
import { api } from "../api";
import type { Artifact, Dataset, Pipeline, ProjectMember } from "../types";
import type { ProjectScope } from "./useProjectScope";

interface ErrorPrefixes {
  dataset: string;
  pipeline: string;
  member: string;
  artifact: string;
}

interface Options {
  scope: ProjectScope;
  prefixes: ErrorPrefixes;
  onError: (message: string) => void;
  onErrorCleared: (prefix: string) => void;
}

/** Project-scoped server resources (datasets/pipelines/membership/artifacts)
 * plus their guarded refresh functions. */
export function useProjectResources({ scope, prefixes, onError, onErrorCleared }: Options) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [membership, setMembership] = useState<ProjectMember | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  const refreshDatasets = useCallback(async (projectId: string) => {
    const ticket = scope.capture();
    try {
      const next = await api.listDatasets(projectId);
      if (ticket?.stillCurrent() && ticket.projectId === projectId) {
        setDatasets(next);
        onErrorCleared(prefixes.dataset);
      }
    } catch (e) {
      if (ticket?.stillCurrent() && ticket.projectId === projectId) {
        onError(`${prefixes.dataset}: ${String(e)}`);
      }
    }
  }, [scope, prefixes.dataset, onError, onErrorCleared]);

  const refreshPipelines = useCallback(async (projectId: string) => {
    const ticket = scope.capture();
    try {
      const next = await api.listPipelines(projectId);
      if (ticket?.stillCurrent() && ticket.projectId === projectId) setPipelines(next);
    } catch (e) {
      if (ticket?.stillCurrent() && ticket.projectId === projectId) {
        onError(`${prefixes.pipeline}: ${String(e)}`);
      }
    }
  }, [scope, prefixes.pipeline, onError]);

  const refreshMembership = useCallback(async (projectId: string) => {
    const ticket = scope.capture();
    try {
      const current = await api.getMembership(projectId);
      const nextMembers = current.role === "admin" ? await api.listMembers(projectId) : [];
      if (ticket?.stillCurrent() && ticket.projectId === projectId) {
        setMembership(current);
        setMembers(nextMembers);
      }
    } catch (e) {
      if (ticket?.stillCurrent() && ticket.projectId === projectId) {
        setMembership(null);
        setMembers([]);
        onError(`${prefixes.member}: ${String(e)}`);
      }
    }
  }, [scope, prefixes.member, onError]);

  const refreshArtifacts = useCallback(async (datasetId: string) => {
    const ticket = scope.capture();
    try {
      const next = await api.listArtifacts(datasetId);
      if (ticket?.stillSelected(datasetId)) setArtifacts(next);
    } catch (e) {
      if (ticket?.stillCurrent()) {
        onError(`${prefixes.artifact}: ${String(e)}`);
      }
    }
  }, [scope, prefixes.artifact, onError]);

  const clearProjectResources = useCallback(() => {
    setDatasets([]);
    setPipelines([]);
    setMembership(null);
    setMembers([]);
    setArtifacts([]);
  }, []);

  return {
    datasets, setDatasets,
    pipelines, setPipelines,
    membership, members,
    artifacts, setArtifacts,
    refreshDatasets, refreshPipelines, refreshMembership, refreshArtifacts,
    clearProjectResources,
  };
}
