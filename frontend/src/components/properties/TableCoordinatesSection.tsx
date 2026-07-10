import { memo } from "react";
import type { Dataset, TableCoordinates } from "../../types";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset;
  tableCoordinates: TableCoordinates;
  onTableCoordinates: (coordinates: TableCoordinates) => void;
}

export const TableCoordinatesSection = memo(function TableCoordinatesSection({
  dataset,
  tableCoordinates,
  onTableCoordinates,
}: Props) {
  const messages = useMessages();
  return (
    <div className="display-controls table-coordinates">
      <strong>{messages.properties.tableCoordinates}</strong>
      {(["x", "y", "z"] as const).map((axis) => (
        <label key={axis}>
          {axis.toUpperCase()}
          <select
            value={tableCoordinates[axis]}
            onChange={(event) =>
              onTableCoordinates({ ...tableCoordinates, [axis]: event.target.value })
            }
          >
            {(dataset.arrays ?? [])
              .filter((array) => array.association === "table" && array.data_type === "numeric")
              .map((array) => <option key={array.name} value={array.name}>{array.name}</option>)}
          </select>
        </label>
      ))}
    </div>
  );
});
