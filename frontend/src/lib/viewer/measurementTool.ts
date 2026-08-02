import vtkWidgetManager from "@kitware/vtk.js/Widgets/Core/WidgetManager";
import vtkLineWidget from "@kitware/vtk.js/Widgets/Widgets3D/LineWidget";
import vtkAngleWidget from "@kitware/vtk.js/Widgets/Widgets3D/AngleWidget";
import type { VtkObject, VtkRenderer } from "./vtkTypes";

export type MeasurementMode = "distance" | "angle";

export interface MeasurementSettings {
  enabled: boolean;
  mode: MeasurementMode;
}

export interface MeasurementResult {
  mode: MeasurementMode;
  value: number;
}

interface VtkSubscription {
  unsubscribe?: () => void;
}

interface MeasurementWidgetFactory extends VtkObject {
  getAngle?: () => number;
  getDistance?: () => number;
  onWidgetChangeEvent: (callback: () => void) => VtkSubscription;
  placeWidget: (bounds: number[]) => void;
  setPickable: (pickable: boolean) => void;
  setVisibility: (visible: boolean) => void;
}

interface MeasurementWidgetManager extends VtkObject {
  addWidget: (widget: MeasurementWidgetFactory) => unknown;
  disablePicking: () => void;
  enablePicking: () => void;
  grabFocus: (widget: MeasurementWidgetFactory) => void;
  releaseFocus: () => void;
  removeWidget: (widget: MeasurementWidgetFactory) => void;
  setRenderer: (renderer: VtkRenderer) => void;
}

export interface MeasurementController {
  apply: (settings: MeasurementSettings) => void;
  reset: () => void;
  delete: () => void;
}

/** LineWidget reports world distance; AngleWidget reports radians. */
export function normalizeMeasurement(mode: MeasurementMode, rawValue: number): number {
  if (!Number.isFinite(rawValue) || rawValue < 0) return 0;
  return mode === "angle" ? rawValue * 180 / Math.PI : rawValue;
}

export function createMeasurementController(
  renderer: VtkRenderer,
  bounds: number[],
  onResult: (result: MeasurementResult | null) => void,
): MeasurementController {
  const manager = vtkWidgetManager.newInstance({
    pickingEnabled: false,
  }) as unknown as MeasurementWidgetManager;
  manager.setRenderer(renderer);
  let settings: MeasurementSettings = { enabled: false, mode: "distance" };
  let factory: MeasurementWidgetFactory | null = null;
  let subscription: VtkSubscription | null = null;
  let deleted = false;

  const disposeWidget = () => {
    subscription?.unsubscribe?.();
    subscription = null;
    if (!factory) return;
    try {
      manager.removeWidget(factory);
    } catch {
      /* renderer teardown may already be in progress */
    }
    factory.delete?.();
    factory = null;
  };

  const buildWidget = (mode: MeasurementMode) => {
    disposeWidget();
    factory = (mode === "distance"
      ? vtkLineWidget.newInstance()
      : vtkAngleWidget.newInstance()) as unknown as MeasurementWidgetFactory;
    factory.placeWidget(bounds);
    manager.addWidget(factory);
    factory.setVisibility(false);
    factory.setPickable(false);
    subscription = factory.onWidgetChangeEvent(() => {
      if (!factory || !settings.enabled) return;
      const rawValue = mode === "distance"
        ? factory.getDistance?.() ?? 0
        : factory.getAngle?.() ?? 0;
      const value = normalizeMeasurement(mode, rawValue);
      onResult(value > 0 ? { mode, value } : null);
    });
  };

  const activate = () => {
    if (!factory) buildWidget(settings.mode);
    factory?.setVisibility(true);
    factory?.setPickable(true);
    manager.enablePicking();
    if (factory) manager.grabFocus(factory);
  };

  const apply = (next: MeasurementSettings) => {
    if (deleted) return;
    const modeChanged = settings.mode !== next.mode;
    settings = next;
    if (modeChanged || !factory) buildWidget(next.mode);
    if (next.enabled) activate();
    else {
      manager.releaseFocus();
      manager.disablePicking();
      factory?.setPickable(false);
      factory?.setVisibility(false);
      onResult(null);
    }
  };

  const reset = () => {
    if (deleted) return;
    buildWidget(settings.mode);
    onResult(null);
    if (settings.enabled) activate();
  };

  buildWidget(settings.mode);
  return {
    apply,
    reset,
    delete: () => {
      if (deleted) return;
      deleted = true;
      onResult(null);
      disposeWidget();
      manager.delete?.();
    },
  };
}
