import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import type { ServerConnection } from "../hooks/useServerConnection";
import { DatasetPanel } from "./DatasetPanel";

vi.mock("../api", () => ({
  api: {
    listDatasets: vi.fn(),
    listAuditEvents: vi.fn(),
    downloadAuditCsv: vi.fn(),
  },
}));

const messages = MESSAGES.en;

function connection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    config: { mode: "server", apiBase: "http://localhost:8000", autoConnect: true, source: "env-server" },
    mode: "server",
    apiBase: "http://localhost:8000",
    status: "connected",
    failure: null,
    capabilities: null,
    suggestedApiBase: "http://localhost:8000",
    epoch: 1,
    connect: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof DatasetPanel>[0]> = {}) {
  const onCreateProject = vi.fn<(name: string) => Promise<boolean>>(async () => true);
  render(
    <MessagesProvider language="en">
      <DatasetPanel
        connection={connection()}
        buildDiagnostics={() => ({})}
        localDatasets={[]}
        localLoadingLabel={null}
        onOpenLocalFiles={vi.fn()}
        onOpenSample={vi.fn()}
        onRemoveLocalDataset={vi.fn()}
        projects={[]}
        currentProjectId={null}
        onSelectProject={vi.fn()}
        onCreateProject={onCreateProject}
        membership={null}
        members={[]}
        onPutMember={vi.fn()}
        onDeleteMember={vi.fn()}
        datasets={[]}
        selectedDatasetId={null}
        onSelectDataset={vi.fn()}
        onUpdateDatasetTags={vi.fn()}
        onUploadFiles={vi.fn()}
        busy={null}
        jobs={[]}
        onCancelJob={vi.fn()}
        cancelingJobIds={new Set()}
        pipelines={[]}
        canSavePipeline={false}
        serverRunAvailable={false}
        onSavePipeline={vi.fn()}
        onRestorePipeline={vi.fn()}
        onDeletePipeline={vi.fn()}
        onRenamePipeline={vi.fn()}
        onRunPipeline={vi.fn()}
        onError={vi.fn()}
        {...overrides}
      />
    </MessagesProvider>,
  );
  return { onCreateProject };
}

describe("DatasetPanel project creation (F-02 / R-05)", () => {
  it("submits with Enter and clears the name only after success", async () => {
    const user = userEvent.setup();
    const { onCreateProject } = renderPanel();
    const input = screen.getByLabelText(messages.datasetPanel.newProjectNameLabel);
    await user.type(input, "  CUA-test  {Enter}");
    await waitFor(() => expect(onCreateProject).toHaveBeenCalledWith("CUA-test"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps the typed name and explains the failure when creation fails", async () => {
    const user = userEvent.setup();
    const { onCreateProject } = renderPanel();
    onCreateProject.mockResolvedValue(false);
    const input = screen.getByLabelText(messages.datasetPanel.newProjectNameLabel);
    await user.type(input, "CUA-test-retry");
    await user.click(screen.getByRole("button", { name: messages.common.create }));
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.datasetPanel.createFailed);
    expect(input).toHaveValue("CUA-test-retry");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("rejects an empty or whitespace-only name with a visible reason", async () => {
    const user = userEvent.setup();
    const { onCreateProject } = renderPanel();
    await user.type(screen.getByLabelText(messages.datasetPanel.newProjectNameLabel), "   ");
    await user.click(screen.getByRole("button", { name: messages.common.create }));
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.datasetPanel.nameRequired);
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("blocks a second submit while the first is pending", async () => {
    const user = userEvent.setup();
    let resolve: (value: boolean) => void = () => {};
    const { onCreateProject } = renderPanel();
    onCreateProject.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await user.type(screen.getByLabelText(messages.datasetPanel.newProjectNameLabel), "slow");
    const button = screen.getByRole("button", { name: messages.common.create });
    await user.click(button);
    expect(screen.getByRole("button", { name: messages.datasetPanel.creating })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    resolve(true);
    await waitFor(() => expect(screen.getByRole("button", { name: messages.common.create })).toBeEnabled());
  });
});

describe("DatasetPanel labels and disabled reasons (F-07)", () => {
  it("names every input and explains why uploads are disabled", () => {
    renderPanel();
    expect(screen.getByLabelText(messages.datasetPanel.projectSelectLabel)).toBeEnabled();
    const single = screen.getByLabelText(messages.datasetPanel.singleFileLabel);
    const bundle = screen.getByLabelText(messages.datasetPanel.bundleLabel);
    expect(single).toBeDisabled();
    expect(bundle).toBeDisabled();
    expect(single).toHaveAccessibleDescription(messages.connection.projectRequired);
    expect(screen.getByLabelText(messages.local.openFileLabel)).toBeEnabled();
    expect(screen.getByLabelText(messages.local.openFolderLabel)).toBeEnabled();
  });

  it("disables the server features until a connection exists", () => {
    renderPanel({ connection: connection({ mode: "static", apiBase: null, status: "disconnected" }) });
    expect(screen.getByLabelText(messages.datasetPanel.projectSelectLabel)).toBeDisabled();
    expect(screen.getByLabelText(messages.datasetPanel.newProjectNameLabel)).toBeDisabled();
    expect(screen.getByText(messages.connection.connectHelp)).toBeTruthy();
  });
});
