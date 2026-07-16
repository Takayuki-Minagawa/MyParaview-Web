import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatsSection } from "./StatsSection";
import { MessagesProvider } from "../../i18n-context";
import { api } from "../../api";
import type { Artifact, DatasetStatistics } from "../../types";

vi.mock("../../api", () => ({
  api: {
    downloadArtifact: vi.fn(),
  },
}));

const downloadArtifact = vi.mocked(api.downloadArtifact);

const STATS: DatasetStatistics = {
  dataset_id: "d1",
  bins: 4,
  arrays: [
    {
      name: "temp",
      association: "point",
      count: 100,
      min: 0,
      max: 10,
      mean: 5,
      stddev: 1.25,
      histogram: { bins: 4, min: 0, max: 10, counts: [10, 40, 30, 20] },
    },
  ],
};

function statsArtifact(id: string): Artifact {
  return {
    id,
    dataset_id: "d1",
    kind: "stats_json",
    filename: "x-stats.json",
    size_bytes: 100,
    content_type: "application/json",
    created_at: "2026-07-16T00:00:00Z",
  };
}

function renderSection(artifacts: Artifact[], onError = vi.fn()) {
  const view = render(
    <MessagesProvider language="en">
      <StatsSection artifacts={artifacts} onError={onError} />
    </MessagesProvider>,
  );
  return { view, onError };
}

describe("StatsSection", () => {
  beforeEach(() => {
    downloadArtifact.mockReset();
  });

  it("renders nothing without a stats artifact", () => {
    renderSection([{ ...statsArtifact("a1"), kind: "converted_vtp" }]);
    expect(screen.queryByText("Statistics")).toBeNull();
  });

  it("loads and renders histograms on demand", async () => {
    downloadArtifact.mockResolvedValue(new Blob([JSON.stringify(STATS)]));
    renderSection([statsArtifact("a1")]);

    await userEvent.click(screen.getByRole("button", { name: "Show histograms" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "temp histogram" })).toBeTruthy());
    expect(downloadArtifact).toHaveBeenCalledWith("a1");
    expect(screen.getByText(/point · temp/)).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy(); // count
    // The load button disappears once statistics render.
    expect(screen.queryByRole("button", { name: "Show histograms" })).toBeNull();
  });

  it("reports malformed stats payloads through onError", async () => {
    downloadArtifact.mockResolvedValue(new Blob(["{\"nope\": true}"]));
    const { onError } = renderSection([statsArtifact("a1")]);

    await userEvent.click(screen.getByRole("button", { name: "Show histograms" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
