import { memo, useEffect, useMemo, useState } from "react";
import type { Artifact, ArrayStatistics, DatasetStatistics } from "../../types";
import { api } from "../../api";
import { useMessages } from "../../i18n-context";

interface Props {
  artifacts: Artifact[];
  onError: (message: string) => void;
}

const HISTOGRAM_WIDTH = 220;
const HISTOGRAM_HEIGHT = 64;

/** Inline SVG bar chart for one array's histogram. */
export function Histogram({ statistics }: { statistics: ArrayStatistics }) {
  const counts = statistics.histogram.counts;
  const peak = Math.max(...counts, 1);
  const barWidth = HISTOGRAM_WIDTH / counts.length;
  return (
    <svg
      role="img"
      aria-label={`${statistics.name} histogram`}
      viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
      className="stats-histogram"
      preserveAspectRatio="none"
    >
      {counts.map((count, index) => {
        const height = (count / peak) * (HISTOGRAM_HEIGHT - 2);
        return (
          <rect
            key={index}
            x={index * barWidth + 0.5}
            y={HISTOGRAM_HEIGHT - height}
            width={Math.max(barWidth - 1, 0.5)}
            height={height}
            fill="currentColor"
          >
            <title>{`${count}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-3)
    ? value.toExponential(3)
    : value.toPrecision(5);
}

/** Loads the newest stats_json artifact on demand and renders per-array
 * histograms with summary statistics. */
export const StatsSection = memo(function StatsSection({ artifacts, onError }: Props) {
  const messages = useMessages();
  const statsArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.kind === "stats_json") ?? null,
    [artifacts],
  );
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [statistics, setStatistics] = useState<DatasetStatistics | null>(null);
  const [loading, setLoading] = useState(false);

  // A newer stats artifact (or a dataset switch) invalidates the loaded data.
  useEffect(() => {
    if (loadedId && loadedId !== statsArtifact?.id) {
      setLoadedId(null);
      setStatistics(null);
    }
  }, [statsArtifact?.id, loadedId]);

  if (!statsArtifact) return null;

  const load = () => {
    if (loading) return;
    setLoading(true);
    void api.downloadArtifact(statsArtifact.id)
      .then(async (blob) => {
        const parsed = JSON.parse(await blob.text()) as DatasetStatistics;
        if (!Array.isArray(parsed.arrays)) {
          throw new Error("stats artifact has no arrays");
        }
        setStatistics(parsed);
        setLoadedId(statsArtifact.id);
      })
      .catch((e) => onError(String(e)))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <h3>{messages.stats.title}</h3>
      {!statistics && (
        <button onClick={load} disabled={loading}>
          {loading ? messages.stats.loading : messages.stats.show}
        </button>
      )}
      {statistics && statistics.arrays.length === 0 && (
        <p className="muted">{messages.stats.empty}</p>
      )}
      {statistics && statistics.arrays.map((array) => (
        <div key={`${array.association}:${array.name}`} className="stats-array">
          <strong>{array.association} · {array.name}</strong>
          <Histogram statistics={array} />
          <table className="stats-table">
            <tbody>
              <tr>
                <th scope="row">{messages.stats.count}</th>
                <td>{array.count}</td>
                <th scope="row">{messages.stats.mean}</th>
                <td>{formatValue(array.mean)}</td>
              </tr>
              <tr>
                <th scope="row">{messages.stats.range}</th>
                <td>{formatValue(array.min)} {messages.properties.rangeSeparator} {formatValue(array.max)}</td>
                <th scope="row">{messages.stats.stddev}</th>
                <td>{formatValue(array.stddev)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
});
