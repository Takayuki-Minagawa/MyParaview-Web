import { memo } from "react";
import type { Artifact, Dataset } from "../../types";
import { api } from "../../api";
import { humanFileSize } from "../../lib/format";
import { triggerBlobDownload } from "../../lib/download";
import { useMessages } from "../../i18n-context";

const STATS_EXTENSIONS = new Set([".vtp", ".vti", ".vtu", ".vts", ".vtr", ".csv"]);
const PROMOTE_EXTENSIONS = [".vtp", ".vti", ".vtu", ".vts", ".vtr", ".pvd", ".csv"];

interface Props {
  dataset: Dataset;
  isClientExportable: boolean;
  artifacts: Artifact[];
  onExport: () => void;
  exportPending: boolean;
  onConvert: () => void;
  convertPending: boolean;
  serverFilterAvailable: boolean;
  onRunStats: () => void;
  statsPending: boolean;
  onClientExport: () => void;
  clientExportPending: boolean;
  onPromoteArtifact: (artifact: Artifact) => void;
  promotePendingIds: ReadonlySet<string>;
  onError: (message: string) => void;
}

export const ArtifactsSection = memo(function ArtifactsSection({
  dataset,
  isClientExportable,
  artifacts,
  onExport,
  exportPending,
  onConvert,
  convertPending,
  serverFilterAvailable,
  onRunStats,
  statsPending,
  onClientExport,
  clientExportPending,
  onPromoteArtifact,
  promotePendingIds,
  onError,
}: Props) {
  const messages = useMessages();
  const isPromotable = (artifact: Artifact) =>
    PROMOTE_EXTENSIONS.some((ext) => artifact.filename.toLowerCase().endsWith(ext));

  return (
    <>
      <h3>{messages.properties.artifacts}</h3>
      <div className="row actions">
        <button disabled={exportPending} onClick={onExport}>
          {exportPending ? messages.properties.exportPending : messages.properties.exportSource}
        </button>
        <button
          disabled={convertPending || dataset.ext === ".vtp" || !serverFilterAvailable}
          onClick={onConvert}
        >
          {convertPending ? messages.common.running : messages.properties.exportConvert}
        </button>
        <button
          disabled={statsPending || !STATS_EXTENSIONS.has(dataset.ext)}
          onClick={onRunStats}
        >
          {statsPending ? messages.properties.statsPending : messages.properties.stats}
        </button>
        {isClientExportable && (
          <button disabled={clientExportPending} onClick={onClientExport}>
            {clientExportPending ? messages.common.running : messages.properties.clientExport}
          </button>
        )}
      </div>
      <p className="muted">{messages.properties.statsHint}</p>
      <ul className="artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              className="link-button"
              onClick={() => {
                void api.downloadArtifact(artifact.id)
                  .then((blob) => triggerBlobDownload(blob, artifact.filename))
                  .catch((e) => onError(String(e)));
              }}
            >
              {artifact.filename}
            </button>
            <span>{artifact.kind} · {humanFileSize(artifact.size_bytes)}</span>
            {isPromotable(artifact) && (
              <button
                disabled={promotePendingIds.has(artifact.id)}
                onClick={() => onPromoteArtifact(artifact)}
              >
                {messages.properties.promoteArtifact}
              </button>
            )}
          </li>
        ))}
        {artifacts.length === 0 && <li className="muted">{messages.properties.emptyArtifacts}</li>}
      </ul>
    </>
  );
});
