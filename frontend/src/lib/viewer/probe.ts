import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";
import vtkPointPicker from "@kitware/vtk.js/Rendering/Core/PointPicker";
import type { VtkAttributes, VtkDataSet, VtkObject, VtkRenderer } from "./vtkTypes";

interface InteractorPosition {
  x: number;
  y: number;
}

interface ProbeInteractor {
  getView?: () => ProbeRenderView | null | undefined;
  onLeftButtonPress?: (
    callback: (event: { position?: InteractorPosition }) => void,
    priority?: number,
  ) => VtkSubscription;
}

interface ProbeRenderView {
  createSelector: () => ProbeSelector;
}

interface ProbeSelector extends VtkObject {
  selectAsync: (
    renderer: VtkRenderer,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => Promise<ProbeSelectionNode[]>;
  setCaptureZValues: (capture: boolean) => void;
  setFieldAssociation: (association: number) => void;
}

interface ProbeSelectionNode {
  getProperties: () => {
    attributeID?: number;
    worldPosition?: [number, number, number];
  };
  getSelectionList: () => number[];
}

interface VtkSubscription {
  unsubscribe?: () => void;
}

interface ProbeRayPicker extends VtkObject {
  getPickPosition: () => number[];
  pick: (selection: [number, number, number], renderer: VtkRenderer) => unknown;
  setTolerance?: (tolerance: number) => void;
}

interface ProbeCellPicker extends ProbeRayPicker {
  getCellId: () => number;
}

interface ProbePointPicker extends ProbeRayPicker {
  getPointId: () => number;
  setUseCells?: (useCells: boolean) => void;
}

export function configureProbePointPicker(
  picker: Pick<ProbePointPicker, "setTolerance" | "setUseCells">,
): void {
  picker.setTolerance?.(0.025);
  // vtk.js 36's useCells branch reports the loop counter instead of the
  // source point index. The normal all-points branch returns the correct ID.
  picker.setUseCells?.(false);
}

export interface ProbeScalarValue {
  association: "point" | "cell";
  name: string;
  value: number;
}

export interface ProbeResult {
  displayPosition: [number, number];
  worldPosition: [number, number, number] | null;
  pointId: number | null;
  cellId: number | null;
  values: ProbeScalarValue[];
}

export interface ProbeController {
  setEnabled: (enabled: boolean) => void;
  delete: () => void;
}

const POINT_ASSOCIATION = 0;
const CELL_ASSOCIATION = 1;
const PICK_RADIUS = 2;

export function scalarValuesAt(
  attributes: VtkAttributes | null | undefined,
  tupleId: number | null,
  association: "point" | "cell",
): ProbeScalarValue[] {
  if (!attributes || tupleId === null || tupleId < 0) return [];
  return (attributes.getArrays?.() ?? []).flatMap((array) => {
    if (array.getNumberOfComponents?.() !== 1 || !array.getName || !array.getTuple) return [];
    const tuple = array.getTuple(tupleId);
    const value = Number(tuple?.[0]);
    if (!Number.isFinite(value)) return [];
    return [{ association, name: array.getName() || "(unnamed)", value }];
  });
}

export function probeValues(
  output: VtkDataSet,
  pointId: number | null,
  cellId: number | null,
): ProbeScalarValue[] {
  return [
    ...scalarValuesAt(output.getPointData(), pointId, "point"),
    ...scalarValuesAt(output.getCellData?.(), cellId, "cell"),
  ];
}

function selectionHit(nodes: ProbeSelectionNode[]) {
  const node = nodes[0];
  if (!node) return { id: null, worldPosition: null };
  const properties = node.getProperties();
  const listId = node.getSelectionList()[0];
  const id = Number.isInteger(listId)
    ? listId
    : Number.isInteger(properties.attributeID)
      ? properties.attributeID ?? null
      : null;
  return {
    id,
    worldPosition: properties.worldPosition ?? null,
  };
}

/** Hardware-select point and cell IDs for a click, then read scalar tuples. */
export function createProbeController(
  renderer: VtkRenderer,
  interactor: ProbeInteractor,
  output: VtkDataSet,
  onResult: (result: ProbeResult | null) => void,
): ProbeController | null {
  const view = interactor.getView?.();
  if (!view?.createSelector || !interactor.onLeftButtonPress) return null;

  let enabled = false;
  let deleted = false;
  let requestId = 0;
  const cellPicker = vtkCellPicker.newInstance() as unknown as ProbeCellPicker;
  const pointPicker = vtkPointPicker.newInstance() as unknown as ProbePointPicker;
  cellPicker.setTolerance?.(0.001);
  configureProbePointPicker(pointPicker);
  const subscription = interactor.onLeftButtonPress((event) => {
    if (!enabled || deleted || !event.position) return;
    const displayPosition: [number, number] = [event.position.x, event.position.y];
    const currentRequest = ++requestId;
    const selector = view.createSelector();
    selector.setCaptureZValues(true);
    const area: [number, number, number, number] = [
      displayPosition[0] - PICK_RADIUS,
      displayPosition[1] - PICK_RADIUS,
      displayPosition[0] + PICK_RADIUS,
      displayPosition[1] + PICK_RADIUS,
    ];

    const pick = async () => {
      try {
        selector.setFieldAssociation(POINT_ASSOCIATION);
        const pointNodes = await selector.selectAsync(renderer, ...area);
        selector.setFieldAssociation(CELL_ASSOCIATION);
        const cellNodes = await selector.selectAsync(renderer, ...area);
        if (deleted || !enabled || currentRequest !== requestId) return;
        let point = selectionHit(pointNodes);
        let cell = selectionHit(cellNodes);
        // Hardware selection is fastest and preserves exact rendered IDs, but
        // some headless/older WebGL drivers return an empty selection buffer.
        // Ray pickers keep Probe functional in that capability gap.
        if (point.id === null || cell.id === null) {
          const selection: [number, number, number] = [
            displayPosition[0], displayPosition[1], 0,
          ];
          if (point.id === null) {
            pointPicker.pick(selection, renderer);
            const pointId = pointPicker.getPointId();
            if (pointId >= 0) {
              point = {
                id: pointId,
                worldPosition: pointPicker.getPickPosition() as [number, number, number],
              };
            }
          }
          if (cell.id === null) {
            cellPicker.pick(selection, renderer);
            const cellId = cellPicker.getCellId();
            if (cellId >= 0) {
              cell = {
                id: cellId,
                worldPosition: cellPicker.getPickPosition() as [number, number, number],
              };
            }
          }
        }
        if (point.id === null && cell.id === null) {
          onResult(null);
          return;
        }
        onResult({
          displayPosition,
          worldPosition: point.worldPosition ?? cell.worldPosition,
          pointId: point.id,
          cellId: cell.id,
          values: probeValues(output, point.id, cell.id),
        });
      } finally {
        selector.delete?.();
      }
    };
    void pick().catch(() => {
      if (!deleted && enabled && currentRequest === requestId) onResult(null);
    });
  }, 1);

  return {
    setEnabled: (next) => {
      enabled = next;
      requestId += 1;
      if (!next) onResult(null);
    },
    delete: () => {
      deleted = true;
      enabled = false;
      requestId += 1;
      subscription.unsubscribe?.();
      pointPicker.delete?.();
      cellPicker.delete?.();
    },
  };
}
