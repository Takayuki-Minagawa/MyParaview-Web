import { memo, useState } from "react";
import { MOVIE_FORMATS } from "../../types";
import type { Artifact, Dataset, MovieFormat, MovieParams } from "../../types";
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
  videoExportAvailable: boolean;
  onRunStats: () => void;
  statsPending: boolean;
  onClientExport: () => void;
  clientExportPending: boolean;
  onMovieExport: (params: MovieParams) => void;
  moviePending: boolean;
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
  videoExportAvailable,
  onRunStats,
  statsPending,
  onClientExport,
  clientExportPending,
  onMovieExport,
  moviePending,
  onPromoteArtifact,
  promotePendingIds,
  onError,
}: Props) {
  const messages = useMessages();
  const [movieFormat, setMovieFormat] = useState<MovieFormat>("zip");
  const [movieFps, setMovieFps] = useState(24);
  const [movieWidth, setMovieWidth] = useState(1280);
  const [movieHeight, setMovieHeight] = useState(720);
  const isPromotable = (artifact: Artifact) =>
    PROMOTE_EXTENSIONS.some((ext) => artifact.filename.toLowerCase().endsWith(ext));
  const movieParamsValid =
    Number.isInteger(movieFps) && movieFps >= 1 && movieFps <= 120 &&
    Number.isInteger(movieWidth) && movieWidth >= 16 && movieWidth <= 4096 &&
    Number.isInteger(movieHeight) && movieHeight >= 16 && movieHeight <= 4096;
  const selectedVideoUnavailable = movieFormat !== "zip" && !videoExportAvailable;

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
      <fieldset className="movie-export">
        <legend>{messages.properties.movieExport}</legend>
        <div className="movie-export-grid">
          <label>
            <span>{messages.properties.movieFormat}</span>
            <select
              value={movieFormat}
              onChange={(event) => setMovieFormat(event.target.value as MovieFormat)}
            >
              {MOVIE_FORMATS.map((format) => (
                <option
                  key={format}
                  value={format}
                  disabled={format !== "zip" && !videoExportAvailable}
                >
                  {messages.properties.movieFormatNames[format]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{messages.properties.movieFps}</span>
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={movieFps}
              disabled={movieFormat === "zip"}
              onChange={(event) => setMovieFps(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{messages.properties.movieWidth}</span>
            <input
              type="number"
              min={16}
              max={4096}
              step={1}
              value={movieWidth}
              onChange={(event) => setMovieWidth(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{messages.properties.movieHeight}</span>
            <input
              type="number"
              min={16}
              max={4096}
              step={1}
              value={movieHeight}
              onChange={(event) => setMovieHeight(Number(event.target.value))}
            />
          </label>
        </div>
        <button
          disabled={
            moviePending || !serverFilterAvailable || selectedVideoUnavailable || !movieParamsValid
          }
          onClick={() => onMovieExport({
            format: movieFormat,
            fps: movieFps,
            width: movieWidth,
            height: movieHeight,
          })}
        >
          {moviePending ? messages.properties.moviePending : messages.properties.movieRun}
        </button>
        <p className="muted">
          {!serverFilterAvailable
            ? messages.properties.movieWorkerUnavailable
            : !videoExportAvailable
              ? messages.properties.movieVideoUnavailable
              : messages.properties.movieHint}
        </p>
      </fieldset>
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
