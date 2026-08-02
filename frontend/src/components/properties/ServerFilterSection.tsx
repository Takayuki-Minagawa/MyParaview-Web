import { memo, useEffect, useState } from "react";
import {
  SERVER_FILTER_NAMES,
  type Dataset,
  type ServerFilterName,
  type ServerFilterParams,
  type SliceAxis,
} from "../../types";
import { AXIS_NORMALS, boundsCenter } from "../../lib/slice";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset;
  sliceAxis: SliceAxis;
  filterPending: boolean;
  serverFilterAvailable: boolean;
  onRunFilter: (params: ServerFilterParams) => void;
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
  const [resampleDimensions, setResampleDimensions] = useState<[string, string, string]>(
    ["50", "50", "50"],
  );
  const [targetReduction, setTargetReduction] = useState("0.5");

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
  const scalarValueValid =
    filterMinimum.trim() !== "" &&
    Number.isFinite(filterMinimumNumber) &&
    (serverFilter !== "threshold" || (
      filterMaximum.trim() !== "" &&
      Number.isFinite(filterMaximumNumber) &&
      filterMinimumNumber <= filterMaximumNumber
    ));
  const dimensionNumbers = resampleDimensions.map(Number) as [number, number, number];
  const dimensionsValid = resampleDimensions.every((value, index) =>
    value.trim() !== "" &&
    Number.isInteger(dimensionNumbers[index]) &&
    dimensionNumbers[index] >= 2 &&
    dimensionNumbers[index] <= 512,
  );
  const targetReductionNumber = Number(targetReduction);
  const targetReductionValid =
    targetReduction.trim() !== "" &&
    Number.isFinite(targetReductionNumber) &&
    targetReductionNumber >= 0 &&
    targetReductionNumber < 1;
  const requiresArray = serverFilter === "contour" || serverFilter === "threshold";
  const filterParamsValid =
    (requiresArray ? scalarValueValid : true) &&
    (serverFilter === "resample" ? dimensionsValid : true) &&
    (serverFilter === "decimate" ? targetReductionValid : true);

  const runFilter = () => {
    if (serverFilter === "slice" || serverFilter === "clip") {
      onRunFilter({
        filter: serverFilter,
        origin: boundsCenter(dataset.bounds),
        normal: AXIS_NORMALS[sliceAxis],
      });
      return;
    }
    if (serverFilter === "cell_to_point") {
      onRunFilter({ filter: serverFilter });
      return;
    }
    if (serverFilter === "resample") {
      if (!dimensionsValid) return;
      onRunFilter({ filter: serverFilter, dimensions: dimensionNumbers });
      return;
    }
    if (serverFilter === "decimate") {
      if (!targetReductionValid) return;
      onRunFilter({ filter: serverFilter, target_reduction: targetReductionNumber });
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
            {SERVER_FILTER_NAMES.map(
              (name) => (
                <option key={name} value={name}>{messages.properties.filterNames[name]}</option>
              ),
            )}
          </select>
        </label>
        {(serverFilter === "slice" || serverFilter === "clip") ? (
          <p className="muted">{sliceAxis}{messages.properties.sliceClipHint}</p>
        ) : requiresArray ? (
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
        ) : serverFilter === "cell_to_point" ? (
          <p className="muted">{messages.properties.cellToPointHint}</p>
        ) : serverFilter === "resample" ? (
          <>
            <p className="muted">{messages.properties.resampleHint}</p>
            {(["X", "Y", "Z"] as const).map((axis, index) => (
              <label key={axis}>
                {messages.properties.resampleDimensions} {axis}
                <input
                  type="number"
                  min="2"
                  max="512"
                  step="1"
                  value={resampleDimensions[index]}
                  onChange={(event) => setResampleDimensions((previous) => {
                    const next: [string, string, string] = [...previous];
                    next[index] = event.target.value;
                    return next;
                  })}
                />
              </label>
            ))}
          </>
        ) : (
          <label>
            {messages.properties.targetReduction}
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={targetReduction}
              onChange={(event) => setTargetReduction(event.target.value)}
            />
          </label>
        )}
        <button
          disabled={
            !serverFilterAvailable ||
            filterPending ||
            (requiresArray && !filterArray) ||
            (requiresArray &&
              !serverArrays.some((array) => `${array.association}:${array.name}` === filterArray)) ||
            !filterParamsValid
          }
          onClick={runFilter}
        >
          {filterPending ? messages.common.running : messages.properties.runFilter}
        </button>
      </div>
    </>
  );
});
