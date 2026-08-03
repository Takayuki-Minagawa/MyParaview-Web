import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import type { CameraState, Dataset } from "../types";
import type { VtkViewerProps } from "./VtkViewer";

const lifecycle = vi.hoisted(() => ({
  mounted: [] as string[],
  unmounted: [] as string[],
}));

vi.mock("./VtkViewer", async () => {
  const React = await import("react");
  return {
    VtkViewer: React.forwardRef((props: VtkViewerProps, ref) => {
      React.useImperativeHandle(ref, () => ({
        screenshot: () => undefined,
        exportGeometry: () => true,
        resetCamera: () => undefined,
      }), []);
      React.useEffect(() => {
        lifecycle.mounted.push(props.contextOwner ?? "unknown");
        return () => { lifecycle.unmounted.push(props.contextOwner ?? "unknown"); };
      }, [props.contextOwner]);
      const movedCamera: CameraState = {
        position: props.contextOwner === "comparison-secondary" ? [9, 8, 7] : [1, 2, 3],
        focal_point: [0, 0, 0],
        view_up: [0, 1, 0],
        parallel_scale: 4,
      };
      return React.createElement(
        "div",
        {
          "data-testid": "mock-viewer",
          "data-owner": props.contextOwner,
          "data-dataset": props.datasetId,
          "data-camera": JSON.stringify(props.cameraState),
        },
        React.createElement(
          "button",
          { onClick: () => props.onCameraChange(movedCamera) },
          `move ${props.contextOwner}`,
        ),
      );
    }),
  };
});

import { ComparisonViewport } from "./ComparisonViewport";

const PRIMARY_CAMERA: CameraState = {
  position: [3, 4, 5],
  focal_point: [0, 0, 0],
  view_up: [0, 1, 0],
  parallel_scale: 2,
};

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "primary.vtp",
    ext: ".vtp",
    size_bytes: 1,
    status: "ready",
    dataset_type: "PolyData",
    created_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

function primaryProps(onCameraChange = vi.fn()): VtkViewerProps {
  return {
    datasetId: "d1",
    url: "/api/datasets/d1/download",
    datasetType: "PolyData",
    representation: "surface",
    colorBy: null,
    colorRange: null,
    opacity: 1,
    colorMap: "cool-to-warm",
    legendVisible: true,
    axesVisible: true,
    tableCoordinates: null,
    imageMode: "slice",
    sliceAxis: "Z",
    sliceIndex: 0,
    volumeOpacityPoints: [{ value: 0, alpha: 0 }, { value: 1, alpha: 1 }],
    cameraState: PRIMARY_CAMERA,
    onCameraChange,
    viewerBackground: [0, 0, 0],
  };
}

function viewport(
  enabled: boolean,
  datasets: Dataset[],
  primary: VtkViewerProps,
  primaryDataset = datasets[0] ?? null,
) {
  return (
    <MessagesProvider language="en">
      <ComparisonViewport
        enabled={enabled}
        datasets={datasets}
        primaryDataset={primaryDataset}
        primaryTimestepIndex={0}
        primary={primary}
      />
    </MessagesProvider>
  );
}

describe("ComparisonViewport lifecycle", () => {
  beforeEach(() => {
    lifecycle.mounted.length = 0;
    lifecycle.unmounted.length = 0;
  });

  it("keeps the primary viewer mounted and only disposes the secondary on toggle", () => {
    const datasets = [dataset()];
    const primary = primaryProps();
    const rendered = render(viewport(false, datasets, primary));
    expect(screen.getAllByTestId("mock-viewer")).toHaveLength(1);

    rendered.rerender(viewport(true, datasets, primary));
    expect(screen.getAllByTestId("mock-viewer")).toHaveLength(2);
    expect(lifecycle.mounted.filter((owner) => owner === "comparison-primary")).toHaveLength(1);
    expect(lifecycle.mounted.filter((owner) => owner === "comparison-secondary")).toHaveLength(1);

    rendered.rerender(viewport(false, datasets, primary));
    expect(screen.getAllByTestId("mock-viewer")).toHaveLength(1);
    expect(lifecycle.unmounted).toEqual(["comparison-secondary"]);
    expect(lifecycle.unmounted).not.toContain("comparison-primary");
  });
});

describe("ComparisonViewport controls", () => {
  beforeEach(() => {
    lifecycle.mounted.length = 0;
    lifecycle.unmounted.length = 0;
  });

  it("routes secondary interaction through shared camera state and supports unlinking", async () => {
    const onPrimaryCamera = vi.fn();
    render(viewport(true, [dataset()], primaryProps(onPrimaryCamera)));

    await userEvent.click(screen.getByRole("button", { name: "move comparison-secondary" }));
    expect(onPrimaryCamera).toHaveBeenCalledTimes(1);

    const sync = screen.getByRole("button", { name: MESSAGES.en.viewer.comparisonCameraSync });
    expect(sync.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(sync);
    expect(sync.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "move comparison-secondary" }));

    expect(onPrimaryCamera).toHaveBeenCalledTimes(1);
    const secondary = screen.getAllByTestId("mock-viewer").find(
      (element) => element.getAttribute("data-owner") === "comparison-secondary",
    );
    await waitFor(() => expect(secondary?.getAttribute("data-camera")).toContain("[9,8,7]"));
  });

  it("switches the right dataset and initializes a same-series comparison to another step", async () => {
    const collection = dataset({
      dataset_type: "Collection",
      filename: "series.pvd",
      extra: { inner_type: "PolyData", bundle_complete: true },
      timesteps: [0, 0.5, 1],
    });
    const other = dataset({ id: "d2", filename: "other.vtu", dataset_type: "UnstructuredGrid" });
    render(viewport(true, [collection, other], {
      ...primaryProps(),
      url: "/api/datasets/d1/timesteps/0/download",
      datasetType: "PolyData",
    }, collection));

    await waitFor(() => {
      expect(screen.getByLabelText(MESSAGES.en.viewer.comparisonRightTimestep))
        .toHaveProperty("value", "1");
    });
    await userEvent.selectOptions(
      screen.getByLabelText(MESSAGES.en.viewer.comparisonRightDataset),
      "d2",
    );
    const secondary = screen.getAllByTestId("mock-viewer").find(
      (element) => element.getAttribute("data-owner") === "comparison-secondary",
    );
    await waitFor(() => expect(secondary?.getAttribute("data-dataset")).toBe("d2"));
    expect(screen.queryByLabelText(MESSAGES.en.viewer.comparisonRightTimestep)).toBeNull();
  });
});
