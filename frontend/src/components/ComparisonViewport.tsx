import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { useMessages } from "../i18n-context";
import {
  camerasEqual,
  clampComparisonTimestep,
  comparisonDatasetType,
  comparisonScalarRange,
  comparisonScalarSelection,
  comparisonSliceIndex,
  comparisonTableCoordinates,
  nextComparisonTimestep,
} from "../lib/comparison";
import type { CameraState, Dataset, ScalarSelection } from "../types";
import { VtkViewer, type VtkViewerHandle, type VtkViewerProps } from "./VtkViewer";

interface Props {
  enabled: boolean;
  datasets: Dataset[];
  primaryDataset: Dataset | null;
  primaryTimestepIndex: number;
  primary: VtkViewerProps;
}

function timestepLabel(dataset: Dataset, index: number): string {
  const time = dataset.timesteps?.[index];
  return time === undefined ? `#${index}` : `#${index} · t=${time}`;
}

/**
 * Keeps the primary VtkViewer mounted while comparison mode is toggled. Only
 * the secondary viewer is created/destroyed, which makes the WebGL lifecycle
 * deterministic and preserves the default single-view camera and tools.
 */
export const ComparisonViewport = forwardRef<VtkViewerHandle, Props>(
  function ComparisonViewport({ enabled, datasets, primaryDataset, primaryTimestepIndex, primary }, ref) {
    const messages = useMessages();
    const primaryRef = useRef<VtkViewerHandle | null>(null);
    const [secondaryDatasetId, setSecondaryDatasetId] = useState<string | null>(null);
    const [secondaryTimestepIndex, setSecondaryTimestepIndex] = useState(0);
    const [cameraSync, setCameraSync] = useState(true);
    const [secondaryCamera, setSecondaryCamera] = useState<CameraState | null>(null);
    const [secondaryRuntimeRange, setSecondaryRuntimeRange] = useState<[number, number] | null>(null);
    const previousSecondaryIdRef = useRef<string | null>(null);

    useImperativeHandle(ref, () => ({
      screenshot: () => primaryRef.current?.screenshot(),
      exportGeometry: () => primaryRef.current?.exportGeometry() ?? false,
      resetCamera: () => primaryRef.current?.resetCamera(),
    }), []);

    const availableDatasets = useMemo(
      () => datasets.filter((dataset) => dataset.status === "ready"),
      [datasets],
    );
    const effectiveSecondaryId = availableDatasets.some(
      (dataset) => dataset.id === secondaryDatasetId,
    )
      ? secondaryDatasetId
      : availableDatasets.some((dataset) => dataset.id === primaryDataset?.id)
        ? primaryDataset?.id ?? null
        : availableDatasets[0]?.id ?? null;
    const secondaryDataset = availableDatasets.find(
      (dataset) => dataset.id === effectiveSecondaryId,
    ) ?? null;

    useEffect(() => {
      const nextId = secondaryDataset?.id ?? null;
      if (previousSecondaryIdRef.current === nextId) return;
      previousSecondaryIdRef.current = nextId;
      setSecondaryTimestepIndex(
        secondaryDataset && secondaryDataset.id === primaryDataset?.id
          ? nextComparisonTimestep(secondaryDataset, primaryTimestepIndex)
          : 0,
      );
      setSecondaryCamera(null);
      setSecondaryRuntimeRange(null);
    }, [secondaryDataset, primaryDataset?.id, primaryTimestepIndex]);

    const effectiveSecondaryTimestep = clampComparisonTimestep(
      secondaryDataset,
      secondaryTimestepIndex,
    );
    const secondaryType = comparisonDatasetType(secondaryDataset);
    const secondaryUrl = secondaryDataset
      ? secondaryDataset.dataset_type === "Collection"
        ? secondaryDataset.extra?.bundle_complete === false
          ? null
          : api.timestepUrl(secondaryDataset.id, effectiveSecondaryTimestep)
        : api.downloadUrl(secondaryDataset.id)
      : null;
    const secondaryColorBy = comparisonScalarSelection(secondaryDataset, primary.colorBy);
    const secondaryMetadataRange = comparisonScalarRange(secondaryDataset, secondaryColorBy);
    const sameDataset = secondaryDataset?.id === primaryDataset?.id;
    const secondaryColorRange = sameDataset && secondaryColorBy === primary.colorBy
      ? primary.colorRange
      : secondaryMetadataRange ?? secondaryRuntimeRange;
    const secondaryCoordinates = comparisonTableCoordinates(
      secondaryDataset,
      primary.tableCoordinates,
    );
    const secondarySliceIndex = comparisonSliceIndex(
      secondaryDataset,
      primary.sliceAxis,
      primary.sliceIndex,
    );

    const onSecondaryCameraChange = useCallback((camera: CameraState) => {
      if (cameraSync) {
        if (!camerasEqual(primary.cameraState, camera)) primary.onCameraChange(camera);
      } else {
        setSecondaryCamera((current) => camerasEqual(current, camera) ? current : camera);
      }
    }, [cameraSync, primary]);

    const onSecondaryRangeResolved = useCallback((
      selection: ScalarSelection,
      range: [number, number],
    ) => {
      if (
        secondaryColorBy?.name === selection.name &&
        secondaryColorBy.association === selection.association
      ) setSecondaryRuntimeRange(range);
    }, [secondaryColorBy]);

    const toggleCameraSync = () => {
      setCameraSync((current) => {
        if (current) setSecondaryCamera(primary.cameraState);
        return !current;
      });
    };

    const secondaryViewer = secondaryDataset ? (
      <VtkViewer
        datasetId={secondaryDataset.id}
        url={secondaryUrl}
        datasetType={secondaryType}
        emptyMessage={secondaryDataset.dataset_type === "Collection"
          && secondaryDataset.extra?.bundle_complete === false
          ? messages.appMessages.incompletePvd
          : undefined}
        representation={primary.representation}
        displayStyle={primary.displayStyle}
        colorBy={secondaryColorBy}
        colorRange={secondaryColorRange}
        opacity={primary.opacity}
        colorMap={primary.colorMap}
        legendVisible={primary.legendVisible}
        axesVisible={primary.axesVisible}
        tableCoordinates={secondaryCoordinates}
        imageMode={primary.imageMode}
        sliceAxis={primary.sliceAxis}
        sliceIndex={secondarySliceIndex}
        volumeOpacityPoints={primary.volumeOpacityPoints}
        onColorRangeResolved={onSecondaryRangeResolved}
        cameraState={cameraSync ? primary.cameraState : secondaryCamera}
        onCameraChange={onSecondaryCameraChange}
        viewerBackground={primary.viewerBackground}
        contextOwner="comparison-secondary"
        viewerLabel={messages.viewer.comparisonRightPane}
      />
    ) : (
      <div className="viewer-overlay">{messages.viewer.comparisonNoDataset}</div>
    );

    return (
      <div className={`comparison-viewport${enabled ? " comparison-enabled" : ""}`}>
        {enabled && (
          <div className="comparison-controls" key="controls">
            <strong>{messages.viewer.comparisonTitle}</strong>
            <label>
              <span>{messages.viewer.comparisonRightDataset}</span>
              <select
                aria-label={messages.viewer.comparisonRightDataset}
                value={effectiveSecondaryId ?? ""}
                disabled={availableDatasets.length === 0}
                onChange={(event) => setSecondaryDatasetId(event.target.value)}
              >
                {availableDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>{dataset.filename}</option>
                ))}
              </select>
            </label>
            {secondaryDataset?.dataset_type === "Collection" && (
              <label>
                <span>{messages.viewer.comparisonRightTimestep}</span>
                <select
                  aria-label={messages.viewer.comparisonRightTimestep}
                  value={effectiveSecondaryTimestep}
                  onChange={(event) => setSecondaryTimestepIndex(Number(event.target.value))}
                >
                  {(secondaryDataset.timesteps ?? []).map((_, index) => (
                    <option key={index} value={index}>{timestepLabel(secondaryDataset, index)}</option>
                  ))}
                </select>
              </label>
            )}
            <button aria-pressed={cameraSync} onClick={toggleCameraSync}>
              {messages.viewer.comparisonCameraSync}
            </button>
            <span className="comparison-context-note">{messages.viewer.comparisonContextNote}</span>
          </div>
        )}
        <div className="comparison-grid" key="grid">
          <section className="comparison-pane comparison-primary">
            {enabled && (
              <span className="comparison-pane-label" key="primary-label">
                {messages.viewer.comparisonLeftPane}: {primaryDataset?.filename ?? "—"}
                {primaryDataset?.dataset_type === "Collection"
                  ? ` · ${timestepLabel(primaryDataset, primaryTimestepIndex)}`
                  : ""}
              </span>
            )}
            <VtkViewer
              key="primary-viewer"
              {...primary}
              ref={primaryRef}
              contextOwner="comparison-primary"
              viewerLabel={enabled ? messages.viewer.comparisonLeftPane : undefined}
            />
          </section>
          {enabled && (
            <section className="comparison-pane comparison-secondary">
              <span className="comparison-pane-label">
                {messages.viewer.comparisonRightPane}: {secondaryDataset?.filename ?? "—"}
                {secondaryDataset?.dataset_type === "Collection"
                  ? ` · ${timestepLabel(secondaryDataset, effectiveSecondaryTimestep)}`
                  : ""}
              </span>
              {secondaryViewer}
            </section>
          )}
        </div>
      </div>
    );
  },
);
