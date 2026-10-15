import { api } from "../api";
import type { Dataset } from "../types";
import { isLocalDataset, localDatasetUrl } from "./localDataset";

/** URL the viewer loads for a dataset: a browser-local blob URL, or the
 * server download / timestep endpoint. Null when nothing can be rendered
 * (incomplete PVD bundle, dataset not ready). */
export function viewerUrlFor(dataset: Dataset | null, timestepIndex: number): string | null {
  if (!dataset) return null;
  if (isLocalDataset(dataset)) return localDatasetUrl(dataset, timestepIndex);
  if (dataset.status !== "ready") return null;
  if (dataset.dataset_type === "Collection") {
    if (dataset.extra?.bundle_complete === false) return null;
    return api.timestepUrl(dataset.id, timestepIndex);
  }
  return api.downloadUrl(dataset.id);
}
