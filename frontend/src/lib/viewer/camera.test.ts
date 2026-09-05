import { describe, expect, it, vi } from "vitest";
import vtkCamera from "@kitware/vtk.js/Rendering/Core/Camera";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import { DEFAULT_DISPLAY_STYLE } from "../../types";
import { camerasEqual } from "../comparison";
import { applyRepresentation, applySavedCamera, readCamera, toggleProjection } from "./camera";
import type { Scene } from "./vtkTypes";

function setup() {
  const camera = vtkCamera.newInstance();
  const actor = vtkActor.newInstance();
  camera.setPosition(3, 4, 12);
  const scene = {
    kind: "geometry", prop: actor, pointGlyph: false,
    renderer: { getActiveCamera: () => camera, resetCameraClippingRange: vi.fn() },
    renderWindow: { render: vi.fn() }, emitCamera: vi.fn(),
  } as unknown as Scene;
  return { scene, camera, actor };
}

describe("ParaView display controls", () => {
  it("distinguishes Surface With Edges and applies actor styling without scalar changes", () => {
    const { scene, actor, camera } = setup();
    const style = { ...DEFAULT_DISPLAY_STYLE, solid_color: "#ff8000", edge_color: "#00ff00", point_size: 12, line_width: 3 };
    applyRepresentation(scene, "surface-with-edges", style);
    expect(actor.getProperty().getEdgeVisibility()).toBe(true);
    expect(actor.getProperty().getRepresentation()).toBe(2);
    expect(actor.getProperty().getColor()).toEqual([1, 128 / 255, 0]);
    expect(actor.getProperty().getEdgeColor()).toEqual([0, 1, 0]);
    expect(actor.getProperty().getLineWidth()).toBe(3);
    applyRepresentation(scene, "surface", style);
    expect(actor.getProperty().getEdgeVisibility()).toBe(false);
    applyRepresentation(scene, "wireframe", style);
    expect(actor.getProperty().getRepresentation()).toBe(1);
    applyRepresentation(scene, "points", style);
    expect(actor.getProperty().getRepresentation()).toBe(0);
    expect(actor.getProperty().getPointSize()).toBe(12);
    actor.delete(); camera.delete();
  });

  it("round trips projection at the same apparent focal-plane size and synchronizes cameras", () => {
    const { scene, camera, actor } = setup();
    const initial = readCamera(scene);
    toggleProjection(scene);
    const parallel = readCamera(scene);
    expect(parallel.parallel_projection).toBe(true);
    expect(parallel.parallel_scale).toBeCloseTo(13 * Math.tan(Math.PI / 12));
    expect(camerasEqual(initial, parallel)).toBe(false);
    const other = setup();
    applySavedCamera(other.scene, parallel);
    expect(camerasEqual(readCamera(other.scene), parallel)).toBe(true);
    toggleProjection(scene);
    expect(camera.getParallelProjection()).toBe(false);
    camera.getPosition().forEach((value: number, index: number) => {
      expect(value).toBeCloseTo(initial.position[index]);
    });
    // Legacy states omitted projection: restoring one must leave parallel mode.
    applySavedCamera(scene, { ...parallel, parallel_projection: undefined });
    expect(camera.getParallelProjection()).toBe(false);
    expect(scene.emitCamera).toHaveBeenCalledTimes(2);
    actor.delete(); camera.delete(); other.actor.delete(); other.camera.delete();
  });

  it("scales small CSV sphere glyphs and leaves image properties alone", () => {
    const { scene, camera, actor } = setup();
    scene.pointGlyph = true;
    scene.pointGlyphBaseRadius = 0.1;
    scene.glyphSource = { setRadius: vi.fn() };
    applyRepresentation(scene, "points", { ...DEFAULT_DISPLAY_STYLE, point_size: 14 });
    expect(scene.glyphSource.setRadius).toHaveBeenCalledWith(0.2);
    expect(actor.getProperty().getRepresentation()).toBe(2);
    applyRepresentation({ kind: "volume" } as Scene, "surface");
    actor.delete(); camera.delete();
  });
});
