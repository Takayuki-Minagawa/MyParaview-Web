/** Minimal structural typings for the vtk.js objects the viewer touches.
 *
 * vtk.js deep imports are untyped in this project (see vtk-shim.d.ts). These
 * interfaces declare only the members the viewer actually calls, so typos in
 * method chains fail at compile time instead of at runtime. They intentionally
 * merge the per-kind mapper/property surfaces: the scene builders guarantee
 * which methods exist for which scene kind.
 */
import type {
  CameraState,
  ColorMapName,
  Representation,
  ScalarSelection,
  SliceAxis,
  VolumeOpacityPoint,
} from "../../types";

export interface VtkObject {
  delete?: () => void;
}

export interface VtkDataArrayLike {
  getNumberOfComponents?: () => number;
  getRange?: (component?: number) => number[] | undefined;
}

export interface VtkAttributes {
  getArrayByName?: (name: string) => VtkDataArrayLike | null;
  getArrays?: () => VtkDataArrayLike[];
  getNumberOfArrays?: () => number;
  setActiveScalars: (name: string) => void;
  addArray: (array: unknown) => void;
}

export interface VtkDataSet extends VtkObject {
  getPointData: () => VtkAttributes;
  getCellData?: () => VtkAttributes;
  getSpacing: () => number[];
  getBounds: () => number[];
  getNumberOfPoints: () => number;
}

/** Union of the mapper members used across geometry/glyph/slice/volume. */
export interface VtkMapper extends VtkObject {
  setLookupTable: (lut: VtkObject) => void;
  setColorModeToMapScalars: () => void;
  setScalarModeToUseCellFieldData: () => void;
  setScalarModeToUsePointFieldData: () => void;
  setColorByArrayName: (name: string) => void;
  setScalarVisibility: (visible: boolean) => void;
  setUseLookupTableScalarRange: (use: boolean) => void;
  setInputConnection: (port: unknown) => void;
  setInputData: (data: unknown) => void;
  setSourceConnection: (port: unknown) => void;
  setSlicingMode: (mode: number) => void;
  setSlice: (index: number) => void;
  setSampleDistance: (distance: number) => void;
}

/** Union of actor/imageSlice/volume property members used by the viewer. */
export interface VtkProperty {
  setRepresentation: (code: number) => void;
  setEdgeVisibility: (visible: boolean) => void;
  setPointSize: (size: number) => void;
  setOpacity: (opacity: number) => void;
  setRGBTransferFunction: (index: number, lut: VtkObject) => void;
  setColorWindow: (window: number) => void;
  setColorLevel: (level: number) => void;
  setScalarOpacity: (index: number, fn: VtkObject) => void;
  setInterpolationTypeToLinear: () => void;
  setShade: (shade: boolean) => void;
}

export interface VtkProp extends VtkObject {
  getProperty: () => VtkProperty;
  setMapper: (mapper: VtkMapper) => void;
}

export interface VtkCamera {
  getPosition: () => number[];
  getFocalPoint: () => number[];
  getViewUp: () => number[];
  getParallelScale: () => number;
  getDistance?: () => number;
  setPosition: (x: number, y: number, z: number) => void;
  setFocalPoint: (x: number, y: number, z: number) => void;
  setViewUp: (x: number, y: number, z: number) => void;
  setParallelScale: (scale?: number) => void;
}

export interface VtkRenderer {
  getActiveCamera: () => VtkCamera;
  resetCamera: () => void;
  resetCameraClippingRange: () => void;
  addActor: (prop: VtkProp) => void;
  addVolume: (prop: VtkProp) => void;
  removeActor: (prop: VtkProp) => void;
  removeVolume: (prop: VtkProp) => void;
  setBackground: (r: number, g: number, b: number) => void;
}

export interface VtkRenderWindow {
  render: () => void;
  captureImages: () => Promise<string>[];
  getInteractor: () => VtkInteractor;
}

export interface VtkInteractor {
  onEndInteractionEvent?: (callback: () => void) => { unsubscribe?: () => void };
  getInteractorStyle?: () => VtkInteractor | null | undefined;
}

export interface VtkGenericRenderWindow extends VtkObject {
  setContainer: (element: HTMLElement) => void;
  resize: () => void;
  getRenderer: () => VtkRenderer;
  getRenderWindow: () => VtkRenderWindow;
  delete: () => void;
}

export interface VtkOrientationWidget extends VtkObject {
  setEnabled: (enabled: boolean) => void;
  setViewportCorner: (corner: unknown) => void;
  setViewportSize: (size: number) => void;
  setMinPixelSize: (size: number) => void;
  setMaxPixelSize: (size: number) => void;
}

export const REPR_CODE: Record<Representation, number> = {
  points: 0,
  wireframe: 1,
  surface: 2,
};

export const SLICE_MODE: Record<SliceAxis, "I" | "J" | "K"> = { X: "I", Y: "J", Z: "K" };

export type CameraPreset = "front" | "side" | "top" | "back" | "bottom" | "isometric";

export interface DisplaySettings {
  representation: Representation;
  colorBy: ScalarSelection | null;
  colorRange: [number, number] | null;
  opacity: number;
  colorMap: ColorMapName;
  cameraState: CameraState | null;
  legendVisible: boolean;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
}

export interface Scene {
  kind: "geometry" | "slice" | "volume";
  grw: VtkGenericRenderWindow;
  renderer: VtkRenderer;
  renderWindow: VtkRenderWindow;
  axes: VtkObject;
  orientationWidget: VtkOrientationWidget;
  resizeObserver: ResizeObserver;
  mapper: VtkMapper | null;
  prop: VtkProp | null;
  reader: VtkObject | null;
  output: VtkDataSet | null;
  createdOutput: boolean;
  glyphSource: VtkObject | null;
  pointGlyph: boolean;
  lut: VtkObject | null;
  opacityFunction: VtkObject | null;
  cameraSubscription: { unsubscribe?: () => void } | null;
  emitCamera: () => void;
  dataDiagnostic?: string;
}
