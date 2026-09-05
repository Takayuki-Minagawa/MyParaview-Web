/** Camera helpers: presets, save/restore, and serialization. */
import { DEFAULT_DISPLAY_STYLE, type DisplayStyle, type CameraState, type Representation } from "../../types";
import type { CameraPreset, Scene } from "./vtkTypes";
import { REPR_CODE } from "./vtkTypes";

export function applyRepresentation(
  scene: Scene, representation: Representation, style: DisplayStyle = DEFAULT_DISPLAY_STYLE,
) {
  if (scene.kind !== "geometry" || !scene.prop) return;
  const property = scene.prop.getProperty();
  property.setRepresentation(scene.pointGlyph ? REPR_CODE.surface : REPR_CODE[representation]);
  property.setEdgeVisibility(representation === "surface-with-edges");
  property.setPointSize(style.point_size);
  property.setLineWidth(style.line_width);
  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
  property.setColor(...rgb(style.solid_color));
  property.setEdgeColor(...rgb(style.edge_color));
  if (scene.pointGlyph && scene.pointGlyphBaseRadius !== undefined) {
    scene.glyphSource?.setRadius?.(scene.pointGlyphBaseRadius * style.point_size / 7);
  }
}

export function applyCameraPreset(scene: Scene | null, preset: CameraPreset) {
  if (!scene) return;
  const camera = scene.renderer.getActiveCamera();
  const focal = camera.getFocalPoint();
  const distance = Math.max(camera.getDistance?.() ?? 1, 1e-6);
  const definitions: Record<CameraPreset, { direction: number[]; up: [number, number, number] }> = {
    front: { direction: [0, -1, 0], up: [0, 0, 1] },
    side: { direction: [1, 0, 0], up: [0, 0, 1] },
    top: { direction: [0, 0, 1], up: [0, 1, 0] },
    back: { direction: [0, 1, 0], up: [0, 0, 1] },
    bottom: { direction: [0, 0, -1], up: [0, -1, 0] },
    isometric: { direction: [1, -1, 1], up: [0, 0, 1] },
  };
  const { direction, up } = definitions[preset];
  const length = Math.hypot(...direction);
  camera.setPosition(
    focal[0] + (direction[0] / length) * distance,
    focal[1] + (direction[1] / length) * distance,
    focal[2] + (direction[2] / length) * distance,
  );
  camera.setViewUp(...up);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
  scene.emitCamera?.();
}

export function readCamera(scene: Scene): CameraState {
  const camera = scene.renderer.getActiveCamera();
  return {
    position: [...camera.getPosition()] as CameraState["position"],
    focal_point: [...camera.getFocalPoint()] as CameraState["focal_point"],
    view_up: [...camera.getViewUp()] as CameraState["view_up"],
    parallel_scale: camera.getParallelScale(),
    parallel_projection: camera.getParallelProjection(),
  };
}

export function applySavedCamera(scene: Scene, state: CameraState) {
  const camera = scene.renderer.getActiveCamera();
  camera.setPosition(...state.position);
  camera.setFocalPoint(...state.focal_point);
  camera.setViewUp(...state.view_up);
  camera.setParallelScale(state.parallel_scale);
  camera.setParallelProjection(state.parallel_projection ?? false);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
}

/** Preserve the apparent size at the focal plane when changing projection. */
export function toggleProjection(scene: Scene | null) {
  if (!scene) return;
  const camera = scene.renderer.getActiveCamera();
  const focal = camera.getFocalPoint();
  const position = camera.getPosition();
  const offset = position.map((value, index) => value - focal[index]);
  const distance = Math.max(Math.hypot(...offset), 1e-6);
  const tangent = Math.tan(camera.getViewAngle() * Math.PI / 360);
  const parallel = !camera.getParallelProjection();
  if (parallel) camera.setParallelScale(distance * tangent);
  else {
    const scale = camera.getParallelScale() / tangent / distance;
    camera.setPosition(
      focal[0] + offset[0] * scale,
      focal[1] + offset[1] * scale,
      focal[2] + offset[2] * scale,
    );
  }
  camera.setParallelProjection(parallel);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
  scene.emitCamera();
}
