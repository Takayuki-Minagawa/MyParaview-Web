import { memo } from "react";
import type { Dataset } from "../../types";
import { formatBounds, formatCount } from "../../lib/format";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset;
}

export const MetadataTable = memo(function MetadataTable({ dataset }: Props) {
  const messages = useMessages();
  return (
    <table className="meta-table">
      <tbody>
        <tr><th>{messages.properties.format}</th><td>{dataset.dataset_type ?? "-"}</td></tr>
        <tr><th>{messages.properties.status}</th><td>{dataset.status}</td></tr>
        <tr><th>{messages.properties.points}</th><td>{formatCount(dataset.num_points)}</td></tr>
        <tr><th>{messages.properties.cells}</th><td>{formatCount(dataset.num_cells)}</td></tr>
        <tr><th>{messages.properties.blocks}</th><td>{formatCount(dataset.num_blocks)}</td></tr>
        <tr><th>{messages.properties.bounds}</th><td className="mono">{formatBounds(dataset.bounds)}</td></tr>
        {dataset.timesteps && (
          <tr>
            <th>{messages.properties.time}</th>
            <td>{dataset.timesteps.length} {messages.properties.stepWord}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
});
