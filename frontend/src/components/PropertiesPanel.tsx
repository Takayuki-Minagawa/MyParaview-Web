import { memo } from "react";
import type { Artifact, Dataset, Job, RenderSession, SliceAxis } from "../types";
import type { DisplayState } from "../hooks/useDisplayState";
import { useMessages } from "../i18n-context";
import { MetadataTable } from "./properties/MetadataTable";
import { DisplaySection } from "./properties/DisplaySection";
import { TimeSection } from "./properties/TimeSection";
import { TableCoordinatesSection } from "./properties/TableCoordinatesSection";
import { ImageSection } from "./properties/ImageSection";
import { ScalarColorSection } from "./properties/ScalarColorSection";
import { ServerFilterSection } from "./properties/ServerFilterSection";
import { AssistantSection } from "./properties/AssistantSection";
import { RemoteSessionSection } from "./properties/RemoteSessionSection";
import { ArtifactsSection } from "./properties/ArtifactsSection";
import { StatsSection } from "./properties/StatsSection";

/** Derived view values and camera commands the raw display state does not
 * carry (clamped slice index, slice bounds, wrapped handlers). */
export interface ViewControls {
  dataColorRange: [number, number] | null;
  /** Clamped to the current dataset's extent. */
  sliceIndex: number;
  sliceMin: number;
  sliceMax: number;
  onSliceAxis: (axis: SliceAxis) => void;
  onTimestepIndex: (index: number) => void;
  onScreenshot: () => void;
  onResetCamera: () => void;
}

/** Job-producing actions plus their pending flags (from useDatasetJobs). */
export interface DatasetJobControls {
  onExport: () => void;
  exportPending: boolean;
  onConvert: () => void;
  convertPending: boolean;
  onRunStats: () => void;
  statsPending: boolean;
  onPromoteArtifact: (artifact: Artifact) => void;
  promotePendingIds: ReadonlySet<string>;
  onClientExport: () => void;
  clientExportPending: boolean;
  filterPending: boolean;
  serverFilterAvailable: boolean;
  onRunFilter: (params: Record<string, unknown>) => void;
  onJobCreated: (job: Job) => void;
  onDownloadTimestep: (index: number) => void;
}

export interface RemoteControls {
  available: boolean;
  session: RenderSession | null;
  pending: boolean;
  onStart: () => void;
  onStop: () => void;
}

interface Props {
  dataset: Dataset | null;
  display: DisplayState;
  view: ViewControls;
  jobs: DatasetJobControls;
  remote: RemoteControls;
  artifacts: Artifact[];
  onError: (message: string) => void;
}

export const PropertiesPanel = memo(function PropertiesPanel({
  dataset,
  display,
  view,
  jobs,
  remote,
  artifacts,
  onError,
}: Props) {
  const messages = useMessages();

  if (!dataset) {
    return (
      <aside className="panel panel-right">
        <h2>{messages.properties.title}</h2>
        <p className="muted">{messages.properties.selectDataset}</p>
      </aside>
    );
  }

  const renderType = dataset.dataset_type === "Collection"
    ? String(dataset.extra?.inner_type ?? "")
    : dataset.dataset_type;
  const isImageData = renderType === "ImageData";
  // UnstructuredGrid renders as an extracted surface, which exports as VTP too.
  const isClientExportable =
    renderType === "PolyData" || renderType === "Table" || renderType === "UnstructuredGrid";

  return (
    <aside className="panel panel-right">
      <h2>{messages.properties.title}</h2>

      <MetadataTable dataset={dataset} />

      <DisplaySection
        isImageData={isImageData}
        representation={display.representation}
        onRepresentation={display.setRepresentation}
        opacity={display.opacity}
        onOpacity={display.setOpacity}
        axesVisible={display.axesVisible}
        onAxesVisible={display.setAxesVisible}
        onScreenshot={view.onScreenshot}
        onResetCamera={view.onResetCamera}
      />

      {dataset.dataset_type === "Collection" && (
        <TimeSection
          dataset={dataset}
          timestepIndex={display.timestepIndex}
          onTimestepIndex={view.onTimestepIndex}
          playing={display.playing}
          onTogglePlayback={() => display.setPlaying((value) => !value)}
          onDownloadTimestep={jobs.onDownloadTimestep}
        />
      )}

      {dataset.dataset_type === "Table" && display.tableCoordinates && (
        <TableCoordinatesSection
          dataset={dataset}
          tableCoordinates={display.tableCoordinates}
          onTableCoordinates={display.setTableCoordinates}
        />
      )}

      {isImageData && (
        <ImageSection
          imageMode={display.imageMode}
          onImageMode={display.setImageMode}
          sliceAxis={display.sliceAxis}
          onSliceAxis={view.onSliceAxis}
          sliceIndex={view.sliceIndex}
          onSliceIndex={display.setSliceIndex}
          sliceMin={view.sliceMin}
          sliceMax={view.sliceMax}
          volumeOpacityPoints={display.volumeOpacityPoints}
          onVolumeOpacityPoints={display.setVolumeOpacityPoints}
        />
      )}

      <ScalarColorSection
        dataset={dataset}
        isImageData={isImageData}
        colorBy={display.colorBy}
        onColorBy={display.setColorBy}
        dataColorRange={view.dataColorRange}
        customColorRange={display.customColorRange}
        onCustomColorRange={display.setCustomColorRange}
        colorMap={display.colorMap}
        onColorMap={display.setColorMap}
        legendVisible={display.legendVisible}
        onLegendVisible={display.setLegendVisible}
      />

      <ServerFilterSection
        dataset={dataset}
        sliceAxis={display.sliceAxis}
        filterPending={jobs.filterPending}
        serverFilterAvailable={jobs.serverFilterAvailable}
        onRunFilter={jobs.onRunFilter}
      />

      <AssistantSection
        dataset={dataset}
        serverFilterAvailable={jobs.serverFilterAvailable}
        filterPending={jobs.filterPending}
        onColorBy={display.setColorBy}
        onColorMap={display.setColorMap}
        onJobCreated={jobs.onJobCreated}
        onError={onError}
      />

      <StatsSection artifacts={artifacts} onError={onError} />

      <RemoteSessionSection
        dataset={dataset}
        remoteAvailable={remote.available}
        remoteSession={remote.session}
        remotePending={remote.pending}
        onStartRemote={remote.onStart}
        onStopRemote={remote.onStop}
      />

      <ArtifactsSection
        dataset={dataset}
        isClientExportable={isClientExportable}
        artifacts={artifacts}
        onExport={jobs.onExport}
        exportPending={jobs.exportPending}
        onConvert={jobs.onConvert}
        convertPending={jobs.convertPending}
        serverFilterAvailable={jobs.serverFilterAvailable}
        onRunStats={jobs.onRunStats}
        statsPending={jobs.statsPending}
        onClientExport={jobs.onClientExport}
        clientExportPending={jobs.clientExportPending}
        onPromoteArtifact={jobs.onPromoteArtifact}
        promotePendingIds={jobs.promotePendingIds}
        onError={onError}
      />
    </aside>
  );
});
