import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import vtkCutter from "@kitware/vtk.js/Filters/Core/Cutter";
import vtkClipClosedSurface from "@kitware/vtk.js/Filters/General/ClipClosedSurface";
import vtkWidgetManager from "@kitware/vtk.js/Widgets/Core/WidgetManager";
import vtkImplicitPlaneWidget from "@kitware/vtk.js/Widgets/Widgets3D/ImplicitPlaneWidget";
import type { Scene, VtkObject } from "./vtkTypes";

export type ClientPlaneMode = "clip" | "slice";
export type ClientPlaneAxis = "X" | "Y" | "Z";

export interface ClientPlaneSettings {
  enabled: boolean;
  mode: ClientPlaneMode;
  axis: ClientPlaneAxis;
  inverted: boolean;
}

interface VtkSubscription {
  unsubscribe?: () => void;
}

interface PlaneState {
  getOrigin: () => [number, number, number];
  getNormal: () => [number, number, number];
  setOrigin: (origin: number[]) => void;
  setNormal: (normal: number[]) => void;
}

interface PlaneWidgetFactory extends VtkObject {
  getWidgetState: () => PlaneState;
  onWidgetChangeEvent: (callback: () => void) => VtkSubscription;
  placeWidget: (bounds: number[]) => void;
  setDragable: (dragable: boolean) => void;
  setPickable: (pickable: boolean) => void;
  setVisibility: (visible: boolean) => void;
}

interface PlaneWidgetManager extends VtkObject {
  addWidget: (widget: PlaneWidgetFactory) => unknown;
  disablePicking: () => void;
  enablePicking: () => void;
  removeWidget: (widget: PlaneWidgetFactory) => void;
  setRenderer: (renderer: unknown) => void;
}

interface PlaneAlgorithm extends VtkObject {
  getOutputPort: () => unknown;
  modified: () => void;
  setInputData: (input: unknown) => void;
}

export interface ClientPlaneController {
  apply: (settings: ClientPlaneSettings) => void;
  reset: () => void;
  delete: () => void;
}

const AXIS_NORMAL: Record<ClientPlaneAxis, [number, number, number]> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
};

/** Return a stable center even for malformed/empty vtk bounds. */
export function boundsCenter(bounds: number[]): [number, number, number] {
  if (bounds.length < 6 || bounds.slice(0, 6).some((value) => !Number.isFinite(value))) {
    return [0, 0, 0];
  }
  return [
    (bounds[0] + bounds[1]) / 2,
    (bounds[2] + bounds[3]) / 2,
    (bounds[4] + bounds[5]) / 2,
  ];
}

export function axisNormal(
  axis: ClientPlaneAxis,
  inverted = false,
): [number, number, number] {
  const sign = inverted ? -1 : 1;
  const normal = AXIS_NORMAL[axis];
  return [
    normal[0] === 0 ? 0 : normal[0] * sign,
    normal[1] === 0 ? 0 : normal[1] * sign,
    normal[2] === 0 ? 0 : normal[2] * sign,
  ];
}

/**
 * Attach one shared implicit plane to a closed-surface clipper, a cutter, and
 * an interactive vtk.js plane widget. The raw scene output stays canonical so
 * disabling the tool restores the original mapper input without refetching.
 */
export function createClientPlaneController(scene: Scene): ClientPlaneController | null {
  if (scene.kind !== "geometry" || !scene.mapper || !scene.output) return null;

  const bounds = scene.output.getBounds();
  const initialOrigin = boundsCenter(bounds);
  const plane = vtkPlane.newInstance({
    origin: initialOrigin,
    normal: AXIS_NORMAL.X,
  });
  const clipper = vtkClipClosedSurface.newInstance({
    clippingPlanes: [plane],
    generateFaces: true,
    passPointData: true,
  }) as unknown as PlaneAlgorithm;
  const cutter = vtkCutter.newInstance({ cutFunction: plane }) as unknown as PlaneAlgorithm;
  clipper.setInputData(scene.output);
  cutter.setInputData(scene.output);

  const widgetManager = vtkWidgetManager.newInstance({
    pickingEnabled: false,
  }) as unknown as PlaneWidgetManager;
  widgetManager.setRenderer(scene.renderer);
  const planeWidget = vtkImplicitPlaneWidget.newInstance() as unknown as PlaneWidgetFactory;
  planeWidget.placeWidget(bounds);
  planeWidget.setDragable(true);
  const widgetState = planeWidget.getWidgetState();
  widgetState.setOrigin(initialOrigin);
  widgetState.setNormal(AXIS_NORMAL.X);
  widgetManager.addWidget(planeWidget);
  planeWidget.setVisibility(false);
  planeWidget.setPickable(false);

  let settings: ClientPlaneSettings = {
    enabled: false,
    mode: "clip",
    axis: "X",
    inverted: false,
  };
  let deleted = false;

  const syncPipeline = () => {
    if (deleted) return;
    plane.setOrigin(widgetState.getOrigin());
    plane.setNormal(widgetState.getNormal());
    clipper.modified();
    cutter.modified();
    scene.renderWindow.render();
  };
  const widgetSubscription = planeWidget.onWidgetChangeEvent(syncPipeline);

  const apply = (next: ClientPlaneSettings) => {
    if (deleted) return;
    const wasEnabled = settings.enabled;
    const directionChanged = settings.axis !== next.axis || settings.inverted !== next.inverted;
    settings = next;
    if (directionChanged) {
      widgetState.setNormal(axisNormal(next.axis, next.inverted));
    }
    if (next.enabled) {
      scene.mapper?.setInputConnection(
        next.mode === "clip" ? clipper.getOutputPort() : cutter.getOutputPort(),
      );
      planeWidget.setVisibility(true);
      planeWidget.setPickable(true);
      widgetManager.enablePicking();
    } else {
      scene.mapper?.setInputData(scene.output);
      planeWidget.setVisibility(false);
      planeWidget.setPickable(false);
      widgetManager.disablePicking();
    }
    if (!wasEnabled && next.enabled) syncPipeline();
    else scene.renderWindow.render();
  };

  const reset = () => {
    if (deleted) return;
    widgetState.setOrigin(initialOrigin);
    widgetState.setNormal(axisNormal(settings.axis, settings.inverted));
    syncPipeline();
  };

  return {
    apply,
    reset,
    delete: () => {
      if (deleted) return;
      deleted = true;
      widgetSubscription.unsubscribe?.();
      try {
        widgetManager.removeWidget(planeWidget);
      } catch {
        /* the render window may already be tearing down */
      }
      widgetManager.delete?.();
      planeWidget.delete?.();
      cutter.delete?.();
      clipper.delete?.();
      plane.delete?.();
    },
  };
}
