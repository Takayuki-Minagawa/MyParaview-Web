import { memo, useEffect, useState } from "react";
import type { Dataset, SliceAxis } from "../../types";
import { AXIS_NORMALS, boundsCenter } from "../../lib/slice";
import { useMessages } from "../../i18n-context";

type ServerFilterName = "slice" | "clip" | "contour" | "threshold";

interface Props {
  dataset: Dataset;
  sliceAxis: SliceAxis;
  filterPending: boolean;
  serverFilterAvailable: boolean;
  onRunFilter: (params: Record<string, unknown>) => void;
}

export const ServerFilterSection = memo(function ServerFilterSection({
  dataset,
  sliceAxis,
  filterPending,
  serverFilterAvailable,
  onRunFilter,
}: Props) {
  const messages = useMessages();
  const [serverFilter, setServerFilter] = useState<ServerFilterName>("contour");
  const [filterArray, setFilterArray] = useState("");
  const [filterMinimum, setFilterMinimum] = useState("0");
  const [filterMaximum, setFilterMaximum] = useState("1");

  useEffect(() => {
    const scalar = (dataset.arrays ?? []).find(
      (array) =>
        (array.association === "point" || array.association === "cell") &&
        array.num_components === 1,
    );
    if (scalar) setFilterArray(`${scalar.association}:${scalar.name}`);
    else setFilterArray("");
    const range = scalar?.value_range;
    if (range) {
      setFilterMinimum(String(range[0]));
      setFilterMaximum(String(range[1]));
    } else {
      setFilterMinimum("0");
      setFilterMaximum("1");
    }
  }, [dataset.id, dataset.arrays]);

  const serverArrays = (dataset.arrays ?? []).filter(
    (array) =>
      (array.association === "point" || array.association === "cell") &&
      array.num_components === 1,
  );
  const filterMinimumNumber = Number(filterMinimum);
  const filterMaximumNumber = Number(filterMaximum);
  const filterNumbersValid =
    filterMinimum.trim() !== "" &&
    Number.isFinite(filterMinimumNumber) &&
    (serverFilter !== "threshold" || (
      filterMaximum.trim() !== "" &&
      Number.isFinite(filterMaximumNumber) &&
      filterMinimumNumber <= filterMaximumNumber
    ));

  const runFilter = () => {
    if (serverFilter === "slice" || serverFilter === "clip") {
      onRunFilter({
        filter: serverFilter,
        origin: boundsCenter(dataset.bounds),
        normal: AXIS_NORMALS[sliceAxis],
      });
      return;
    }
    const [association, ...nameParts] = filterArray.split(":");
    const array = nameParts.join(":");
    if (!array) return;
    if (serverFilter === "contour") {
      onRunFilter({
        filter: serverFilter,
        array,
        association: association === "cell" ? "CELLS" : "POINTS",
        value: Number(filterMinimum),
      });
    } else {
      onRunFilter({
        filter: serverFilter,
        array,
        association: association === "cell" ? "CELLS" : "POINTS",
        minimum: Number(filterMinimum),
        maximum: Number(filterMaximum),
      });
    }
  };

  return (
    <>
      <h3>{messages.properties.serverFilter}</h3>
      <div className="display-controls">
        {!serverFilterAvailable && (
          <p className="muted">{messages.properties.workerMissing}</p>
        )}
        <label>
          {messages.properties.filter}
          <select value={serverFilter} onChange={(event) => setServerFilter(event.target.value as ServerFilterName)}>
            {(Object.entries(messages.properties.filterNames) as [ServerFilterName, string][]).map(
              ([name, label]) => (
                <option key={name} value={name}>{label}</option>
              ),
            )}
          </select>
        </label>
        {(serverFilter === "slice" || serverFilter === "clip") ? (
          <p className="muted">{sliceAxis}{messages.properties.sliceClipHint}</p>
        ) : (
          <>
            <label>
              {messages.properties.array}
              <select value={filterArray} onChange={(event) => setFilterArray(event.target.value)}>
                {serverArrays.map((array) => (
                  <option key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>
                    {messages.properties.associationNames[array.association]} · {array.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {serverFilter === "contour" ? messages.properties.contourValue : messages.properties.minimum}
              <input type="number" value={filterMinimum} onChange={(event) => setFilterMinimum(event.target.value)} />
            </label>
            {serverFilter === "threshold" && (
              <label>
                {messages.properties.maximum}
                <input type="number" value={filterMaximum} onChange={(event) => setFilterMaximum(event.target.value)} />
              </label>
            )}
          </>
        )}
        <button
          disabled={
            !serverFilterAvailable ||
            filterPending ||
            ((serverFilter === "contour" || serverFilter === "threshold") && !filterArray) ||
            ((serverFilter === "contour" || serverFilter === "threshold") &&
              !serverArrays.some((array) => `${array.association}:${array.name}` === filterArray)) ||
            !filterNumbersValid
          }
          onClick={runFilter}
        >
          {filterPending ? messages.common.running : messages.properties.runFilter}
        </button>
      </div>
    </>
  );
});
