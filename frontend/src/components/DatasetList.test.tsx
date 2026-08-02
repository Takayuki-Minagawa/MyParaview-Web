import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import type { Dataset } from "../types";
import { DatasetList } from "./DatasetList";

vi.mock("../api", () => ({
  api: {
    listDatasets: vi.fn(),
  },
}));

const listDatasets = vi.mocked(api.listDatasets);
const messages = MESSAGES.en;

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "mesh.vtp",
    ext: ".vtp",
    size_bytes: 1024,
    status: "ready",
    tags: ["Review", "Thermal"],
    created_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

function renderList(overrides: Partial<Parameters<typeof DatasetList>[0]> = {}) {
  const handlers = {
    onSelectDataset: vi.fn(),
    onUpdateDatasetTags: vi.fn<Parameters<typeof DatasetList>[0]["onUpdateDatasetTags"]>(),
    onError: vi.fn(),
  };
  render(
    <MessagesProvider language="en">
      <DatasetList
        projectId="p1"
        datasets={[dataset()]}
        selectedDatasetId={null}
        canEditTags={true}
        {...handlers}
        {...overrides}
      />
    </MessagesProvider>,
  );
  return handlers;
}

describe("DatasetList search", () => {
  beforeEach(() => {
    listDatasets.mockReset();
  });

  it("submits name and tag filters to the API and can restore the full list", async () => {
    const user = userEvent.setup();
    listDatasets.mockResolvedValue([
      dataset({ id: "d2", filename: "thermal-result.vtp", tags: ["Thermal"] }),
    ]);
    renderList();

    await user.type(screen.getByLabelText(messages.datasetPanel.searchNameLabel), " thermal ");
    await user.type(screen.getByLabelText(messages.datasetPanel.tagFilterLabel), " Thermal ");
    await user.click(screen.getByRole("button", { name: messages.datasetPanel.search }));

    await waitFor(() => {
      expect(listDatasets).toHaveBeenCalledWith("p1", {
        name: " thermal ",
        tag: " Thermal ",
      });
    });
    expect(await screen.findByText("thermal-result.vtp")).toBeTruthy();
    expect(screen.queryByText("mesh.vtp")).toBeNull();

    await user.click(screen.getByRole("button", { name: messages.datasetPanel.clearSearch }));
    expect(screen.getByText("mesh.vtp")).toBeTruthy();
  });

  it("shows the filtered empty state", async () => {
    listDatasets.mockResolvedValue([]);
    renderList();
    await userEvent.click(screen.getByRole("button", { name: messages.datasetPanel.search }));
    expect(await screen.findByText(messages.datasetPanel.noMatchingDatasets)).toBeTruthy();
  });
});

describe("DatasetList tag editing", () => {
  beforeEach(() => {
    listDatasets.mockReset();
  });

  it("displays tags and lets editors save a trimmed comma-separated list", async () => {
    const user = userEvent.setup();
    const handlers = renderList();
    handlers.onUpdateDatasetTags.mockResolvedValue(
      dataset({ tags: ["Thermal", "Approved"] }),
    );

    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Thermal")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: `mesh.vtp${messages.datasetPanel.editTagsLabel}` }));
    expect(handlers.onSelectDataset).not.toHaveBeenCalled();

    const input = screen.getByLabelText(messages.datasetPanel.tagsInputLabel);
    await user.clear(input);
    await user.type(input, " Thermal, , Approved ");
    await user.click(screen.getByRole("button", { name: messages.common.save }));

    await waitFor(() => {
      expect(handlers.onUpdateDatasetTags).toHaveBeenCalledWith(
        "d1",
        ["Thermal", "Approved"],
      );
    });
    expect(screen.queryByLabelText(messages.datasetPanel.tagsInputLabel)).toBeNull();
  });

  it("does not expose tag editing to viewers", () => {
    renderList({ canEditTags: false });
    expect(
      screen.queryByRole("button", { name: `mesh.vtp${messages.datasetPanel.editTagsLabel}` }),
    ).toBeNull();
  });
});
