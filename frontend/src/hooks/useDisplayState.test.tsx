import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CameraState } from "../types";
import { DEFAULT_VOLUME_OPACITY_POINTS } from "../lib/imageData";
import { useDisplayState } from "./useDisplayState";

const CAMERA: CameraState = {
  position: [1, 2, 3],
  focal_point: [0, 0, 0],
  view_up: [0, 1, 0],
  parallel_scale: 2,
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
    const { setColorBy, reset, setOpacity } = result.current;
    act(() => result.current.setOpacity(0.5));
    expect(result.current.setColorBy).toBe(setColorBy);
    expect(result.current.reset).toBe(reset);
    expect(result.current.setOpacity).toBe(setOpacity);
  });
});
