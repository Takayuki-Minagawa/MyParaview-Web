import type {
  ColorMapName,
  Dataset,
  Representation,
  ScalarSelection,
  Artifact,
  ImageMode,
  SliceAxis,
  TableCoordinates,
} from "../types";
import type { VolumeOpacityPoint, RenderSession, Job } from "../types";
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

interface Props {
  dataset: Dataset | null;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  colorBy: ScalarSelection | null;
  onColorBy: (selection: ScalarSelection | null) => void;
  dataColorRange: [number, number] | null;
  customColorRange: [number, number] | null;
  onCustomColorRange: (range: [number, number] | null) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  colorMap: ColorMapName;
  onColorMap: (name: ColorMapName) => void;
  legendVisible: boolean;
  onLegendVisible: (visible: boolean) => void;
  onScreenshot: () => void;
  onResetCamera: () => void;
  axesVisible: boolean;
  onAxesVisible: (visible: boolean) => void;
  artifacts: Artifact[];
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
  tableCoordinates: TableCoordinates | null;
  onTableCoordinates: (coordinates: TableCoordinates) => void;
  imageMode: ImageMode;
  onImageMode: (mode: ImageMode) => void;
  sliceAxis: SliceAxis;
  onSliceAxis: (axis: SliceAxis) => void;
  sliceIndex: number;
  onSliceIndex: (index: number) => void;
  sliceMin: number;
  sliceMax: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
  onVolumeOpacityPoints: (points: VolumeOpacityPoint[]) => void;
  timestepIndex: number;
  onTimestepIndex: (index: number) => void;
  playing: boolean;
  onTogglePlayback: () => void;
  onDownloadTimestep: (index: number) => void;
  remoteAvailable: boolean;
  remoteSession: RenderSession | null;
  remotePending: boolean;
  onStartRemote: () => void;
  onStopRemote: () => void;
  onError: (message: string) => void;
}

export function PropertiesPanel({
  dataset,
  representation,
  onRepresentation,
  colorBy,
  onColorBy,
  dataColorRange,
  customColorRange,
  onCustomColorRange,
  opacity,
  onOpacity,
  colorMap,
  onColorMap,
  legendVisible,
  onLegendVisible,
  onScreenshot,
  onResetCamera,
  axesVisible,
  onAxesVisible,
  artifacts,
  onExport,
  exportPending,
  onConvert,
  convertPending,
  onRunStats,
  statsPending,
  onPromoteArtifact,
  promotePendingIds,
  onClientExport,
  clientExportPending,
  filterPending,
  serverFilterAvailable,
  onRunFilter,
  onJobCreated,
  tableCoordinates,
  onTableCoordinates,
  imageMode,
  onImageMode,
  sliceAxis,
  onSliceAxis,
  sliceIndex,
  onSliceIndex,
  sliceMin,
  sliceMax,
  volumeOpacityPoints,
  onVolumeOpacityPoints,
  timestepIndex,
  onTimestepIndex,
  playing,
  onTogglePlayback,
  onDownloadTimestep,
  remoteAvailable,
  remoteSession,
  remotePending,
  onStartRemote,
  onStopRemote,
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
  const isClientExportable = renderType === "PolyData" || renderType === "Table";

  return (
    <aside className="panel panel-right">
      <h2>{messages.properties.title}</h2>

      <MetadataTable dataset={dataset} />

      <DisplaySection
        isImageData={isImageData}
        representation={representation}
        onRepresentation={onRepresentation}
        opacity={opacity}
        onOpacity={onOpacity}
        axesVisible={axesVisible}
        onAxesVisible={onAxesVisible}
        onScreenshot={onScreenshot}
        onResetCamera={onResetCamera}
      />

      {dataset.dataset_type === "Collection" && (
        <TimeSection
          dataset={dataset}
          timestepIndex={timestepIndex}
          onTimestepIndex={onTimestepIndex}
          playing={playing}
          onTogglePlayback={onTogglePlayback}
          onDownloadTimestep={onDownloadTimestep}
        />
      )}

      {dataset.dataset_type === "Table" && tableCoordinates && (
        <TableCoordinatesSection
          dataset={dataset}
          tableCoordinates={tableCoordinates}
          onTableCoordinates={onTableCoordinates}
        />
      )}

      {isImageData && (
        <ImageSection
          imageMode={imageMode}
          onImageMode={onImageMode}
          sliceAxis={sliceAxis}
          onSliceAxis={onSliceAxis}
          sliceIndex={sliceIndex}
          onSliceIndex={onSliceIndex}
          sliceMin={sliceMin}
          sliceMax={sliceMax}
          volumeOpacityPoints={volumeOpacityPoints}
          onVolumeOpacityPoints={onVolumeOpacityPoints}
        />
      )}

      <ScalarColorSection
        dataset={dataset}
        isImageData={isImageData}
        colorBy={colorBy}
        onColorBy={onColorBy}
        dataColorRange={dataColorRange}
        customColorRange={customColorRange}
        onCustomColorRange={onCustomColorRange}
        colorMap={colorMap}
        onColorMap={onColorMap}
        legendVisible={legendVisible}
        onLegendVisible={onLegendVisible}
      />

      <ServerFilterSection
        dataset={dataset}
        sliceAxis={sliceAxis}
        filterPending={filterPending}
        serverFilterAvailable={serverFilterAvailable}
        onRunFilter={onRunFilter}
      />

      <AssistantSection
        dataset={dataset}
        serverFilterAvailable={serverFilterAvailable}
        filterPending={filterPending}
        onColorBy={onColorBy}
        onColorMap={onColorMap}
        onJobCreated={onJobCreated}
        onError={onError}
      />

      <RemoteSessionSection
        dataset={dataset}
        remoteAvailable={remoteAvailable}
        remoteSession={remoteSession}
        remotePending={remotePending}
        onStartRemote={onStartRemote}
        onStopRemote={onStopRemote}
      />

      <ArtifactsSection
        dataset={dataset}
        isClientExportable={isClientExportable}
        artifacts={artifacts}
        onExport={onExport}
        exportPending={exportPending}
        onConvert={onConvert}
        convertPending={convertPending}
        serverFilterAvailable={serverFilterAvailable}
        onRunStats={onRunStats}
        statsPending={statsPending}
        onClientExport={onClientExport}
        clientExportPending={clientExportPending}
        onPromoteArtifact={onPromoteArtifact}
        promotePendingIds={promotePendingIds}
        onError={onError}
      />
    </aside>
  );
}
