import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CameraState, ViewState } from "../types";
import { DEFAULT_VOLUME_OPACITY_POINTS } from "../lib/imageData";
import { DISPLAY_HISTORY_LIMIT, useDisplayState } from "./useDisplayState";

const CAMERA: CameraState = {
  position: [1, 2, 3],
  focal_point: [0, 0, 0],
  view_up: [0, 1, 0],
  parallel_scale: 2,
};

const RESTORED_VIEW_STATE: ViewState = {
  schema_version: 1,
  representation: "wireframe",
  color_by: { name: "Temperature", association: "point" },
  color_range: [10, 20],
  opacity: 0.4,
  color_map: "viridis",
  legend_visible: false,
  camera: CAMERA,
  table_coordinates: { x: "x", y: "y", z: "z" },
  image_mode: "volume",
  slice_axis: "X",
  slice_index: 6,
  timestep_index: 3,
  volume_opacity_points: [{ value: 0, alpha: 0.1 }, { value: 1, alpha: 0.9 }],
};

describe("useDisplayState defaults", () => {
  it("starts with the documented initial values", () => {
    const { result } = renderHook(useDisplayState);
    expect(result.current.representation).toBe("surface");
    expect(result.current.colorBy).toBeNull();
    expect(result.current.customColorRange).toBeNull();
    expect(result.current.runtimeColorRange).toBeNull();
    expect(result.current.opacity).toBe(1);
    expect(result.current.colorMap).toBe("cool-to-warm");
    expect(result.current.legendVisible).toBe(true);
    expect(result.current.axesVisible).toBe(true);
    expect(result.current.cameraState).toBeNull();
    expect(result.current.tableCoordinates).toBeNull();
    expect(result.current.imageMode).toBe("slice");
    expect(result.current.sliceAxis).toBe("Z");
    expect(result.current.sliceIndex).toBe(0);
    expect(result.current.timestepIndex).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.volumeOpacityPoints).toBe(DEFAULT_VOLUME_OPACITY_POINTS);
  });
});

describe("useDisplayState setters", () => {
  it("updates individual fields", () => {
    const { result } = renderHook(useDisplayState);
    act(() => {
      result.current.setRepresentation("points");
      result.current.setOpacity(0.25);
      result.current.setSliceIndex(7);
    });
    expect(result.current.representation).toBe("points");
    expect(result.current.opacity).toBe(0.25);
    expect(result.current.sliceIndex).toBe(7);
  });

  it("setColorBy invalidates both the manual and runtime color ranges", () => {
    const { result } = renderHook(useDisplayState);
    act(() => {
      result.current.setCustomColorRange([0, 10]);
      result.current.setRuntimeColorRange([1, 9]);
    });
    expect(result.current.customColorRange).toEqual([0, 10]);
    expect(result.current.runtimeColorRange).toEqual([1, 9]);

    act(() => {
      result.current.setColorBy({ name: "Temperature", association: "point" });
    });
    expect(result.current.colorBy).toEqual({ name: "Temperature", association: "point" });
    expect(result.current.customColorRange).toBeNull();
    expect(result.current.runtimeColorRange).toBeNull();
  });

  it("setColorByState leaves the color ranges untouched", () => {
    const { result } = renderHook(useDisplayState);
    act(() => {
      result.current.setCustomColorRange([0, 10]);
      result.current.setColorByState({ name: "Pressure", association: "cell" });
    });
    expect(result.current.colorBy).toEqual({ name: "Pressure", association: "cell" });
    expect(result.current.customColorRange).toEqual([0, 10]);
  });
});

describe("useDisplayState reset", () => {
  function populate(result: { current: ReturnType<typeof useDisplayState> }) {
    act(() => {
      result.current.setRepresentation("wireframe");
      result.current.setColorBy({ name: "Temperature", association: "point" });
      result.current.setCustomColorRange([0, 10]);
      result.current.setRuntimeColorRange([1, 9]);
      result.current.setOpacity(0.4);
      result.current.setColorMap("viridis");
      result.current.setLegendVisible(false);
      result.current.setAxesVisible(false);
      result.current.setCameraState(CAMERA);
      result.current.setTableCoordinates({ x: "a", y: "b", z: "c" });
      result.current.setImageMode("volume");
      result.current.setSliceAxis("X");
      result.current.setSliceIndex(5);
      result.current.setTimestepIndex(3);
      result.current.setPlaying(true);
      result.current.setVolumeOpacityPoints([{ value: 0.5, alpha: 0.2 }]);
    });
  }

  it("restores every per-dataset field to its initial value", () => {
    const { result } = renderHook(useDisplayState);
    populate(result);
    act(() => result.current.reset());

    expect(result.current.colorBy).toBeNull();
    expect(result.current.customColorRange).toBeNull();
    expect(result.current.runtimeColorRange).toBeNull();
    expect(result.current.cameraState).toBeNull();
    expect(result.current.tableCoordinates).toBeNull();
    expect(result.current.imageMode).toBe("slice");
    expect(result.current.sliceAxis).toBe("Z");
    expect(result.current.sliceIndex).toBe(0);
    expect(result.current.timestepIndex).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.volumeOpacityPoints).toBe(DEFAULT_VOLUME_OPACITY_POINTS);
  });

  it("preserves viewer-level preferences across reset", () => {
    const { result } = renderHook(useDisplayState);
    populate(result);
    act(() => result.current.reset());

    // These survive a dataset/project switch by design.
    expect(result.current.representation).toBe("wireframe");
    expect(result.current.opacity).toBe(0.4);
    expect(result.current.colorMap).toBe("viridis");
    expect(result.current.legendVisible).toBe(false);
    expect(result.current.axesVisible).toBe(false);
  });

  it("creates a hard history boundary", () => {
    const { result } = renderHook(useDisplayState);
    act(() => result.current.setOpacity(0.5));
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.reset());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.opacity).toBe(0.5);
  });
});

describe("useDisplayState history", () => {
  it("undoes and redoes tracked display changes", () => {
    const { result } = renderHook(useDisplayState);
    act(() => result.current.setOpacity(0.25));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.undo());
    expect(result.current.opacity).toBe(1);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.opacity).toBe(0.25);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("deduplicates equivalent values and excludes transient viewer preferences", () => {
    const { result } = renderHook(useDisplayState);
    act(() => {
      result.current.setVolumeOpacityPoints(DEFAULT_VOLUME_OPACITY_POINTS.map((point) => ({
        ...point,
      })));
      result.current.setRuntimeColorRange([1, 2]);
      result.current.setPlaying(true);
      result.current.setAxesVisible(false);
    });
    expect(result.current.canUndo).toBe(false);
  });

  it("clears redo when a new display change branches the history", () => {
    const { result } = renderHook(useDisplayState);
    act(() => result.current.setOpacity(0.25));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.setRepresentation("points"));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.representation).toBe("points");
  });

  it("applies a saved ViewState as one atomic history entry", () => {
    const { result } = renderHook(useDisplayState);
    act(() => result.current.restoreViewState(RESTORED_VIEW_STATE));

    expect(result.current.representation).toBe("wireframe");
    expect(result.current.colorBy).toEqual(RESTORED_VIEW_STATE.color_by);
    expect(result.current.customColorRange).toEqual([10, 20]);
    expect(result.current.opacity).toBe(0.4);
    expect(result.current.cameraState).toEqual(CAMERA);
    expect(result.current.sliceIndex).toBe(6);
    expect(result.current.timestepIndex).toBe(3);
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.representation).toBe("surface");
    expect(result.current.colorBy).toBeNull();
    expect(result.current.opacity).toBe(1);
    expect(result.current.cameraState).toBeNull();
    expect(result.current.sliceIndex).toBe(0);
    expect(result.current.timestepIndex).toBe(0);
    // A single undo reversed the complete restore transaction.
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    expect(result.current.representation).toBe("wireframe");
    expect(result.current.volumeOpacityPoints).toEqual(
      RESTORED_VIEW_STATE.volume_opacity_points,
    );
  });

  it("does not create history for a no-op ViewState restore", () => {
    const { result } = renderHook(useDisplayState);
    act(() => result.current.restoreViewState({
      schema_version: 1,
      representation: "surface",
      color_by: null,
      color_range: null,
      opacity: 1,
      color_map: "cool-to-warm",
      legend_visible: true,
      camera: null,
    }));
    expect(result.current.canUndo).toBe(false);
  });

  it("retains only the most recent bounded number of snapshots", () => {
    const { result } = renderHook(useDisplayState);
    for (let index = 1; index <= DISPLAY_HISTORY_LIMIT + 2; index += 1) {
      act(() => result.current.setSliceIndex(index));
    }

    for (let index = 0; index < DISPLAY_HISTORY_LIMIT; index += 1) {
      expect(result.current.canUndo).toBe(true);
      act(() => result.current.undo());
    }
    expect(result.current.sliceIndex).toBe(2);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.sliceIndex).toBe(2);
  });
});

describe("useDisplayState identity", () => {
  it("keeps the same object across re-renders when nothing changed", () => {
    const { result, rerender } = renderHook(useDisplayState);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("produces a new object once a display value changes", () => {
    const { result } = renderHook(useDisplayState);
    const first = result.current;
    act(() => result.current.setOpacity(0.5));
    expect(result.current).not.toBe(first);
    expect(result.current.opacity).toBe(0.5);
  });

  it("keeps setter and reset references stable across state changes", () => {
    const { result } = renderHook(useDisplayState);
    const { setColorBy, reset, setOpacity, undo, redo, restoreViewState } = result.current;
    act(() => result.current.setOpacity(0.5));
    expect(result.current.setColorBy).toBe(setColorBy);
    expect(result.current.reset).toBe(reset);
    expect(result.current.setOpacity).toBe(setOpacity);
    expect(result.current.undo).toBe(undo);
    expect(result.current.redo).toBe(redo);
    expect(result.current.restoreViewState).toBe(restoreViewState);
  });
});
