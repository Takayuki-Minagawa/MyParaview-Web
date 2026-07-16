/** Camera helpers: presets, save/restore, and serialization. */
import type { CameraState, Representation } from "../../types";
import type { CameraPreset, Scene } from "./vtkTypes";
import { REPR_CODE } from "./vtkTypes";

export function applyRepresentation(scene: Scene, representation: Representation) {
  if (scene.kind !== "geometry" || !scene.prop) return;
  const property = scene.prop.getProperty();
  property.setRepresentation(scene.pointGlyph ? REPR_CODE.surface : REPR_CODE[representation]);
  property.setEdgeVisibility(representation === "surface");
  property.setPointSize(representation === "points" ? 7 : 1);
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
  };
}

export function applySavedCamera(scene: Scene, state: CameraState) {
  const camera = scene.renderer.getActiveCamera();
  camera.setPosition(...state.position);
  camera.setFocalPoint(...state.focal_point);
  camera.setViewUp(...state.view_up);
  camera.setParallelScale(state.parallel_scale);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
}
