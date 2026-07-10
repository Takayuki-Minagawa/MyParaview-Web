import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { PipelinePanel } from "./PipelinePanel";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import type { Pipeline, PipelineNode } from "../types";

const messages = MESSAGES.ja;

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return {
    id: "n-reader",
    pipeline_id: "pl1",
    node_type: "reader",
    name: "Reader",
    params: {},
    ...overrides,
  };
}

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pl1",
    project_id: "p1",
    name: "State A",
    created_at: "2026-01-01T00:00:00Z",
    nodes: [makeNode()],
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ComponentProps<typeof PipelinePanel>> = {}) {
  const handlers = {
    onSave: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onRun: vi.fn(),
  };
  render(
    <MessagesProvider language="ja">
      <PipelinePanel
        pipelines={[]}
        canSave={true}
        serverRunAvailable={true}
        {...handlers}
        {...overrides}
      />
    </MessagesProvider>,
  );
  return handlers;
}

function listItemFor(pipeline: Pipeline) {
  const item = screen.getByText(pipeline.name, { selector: "strong" }).closest("li");
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

describe("PipelinePanel save", () => {
  it("keeps save disabled when canSave is false even with a name", async () => {
    const user = userEvent.setup();
    renderPanel({ canSave: false });
    const button = screen.getByRole("button", { name: messages.common.save }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText(messages.pipelinePanel.saveNameLabel), "My State");
    expect(button.disabled).toBe(true);
  });

  it("keeps save disabled while the name is empty or whitespace", async () => {
    const user = userEvent.setup();
    renderPanel();
    const button = screen.getByRole("button", { name: messages.common.save }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText(messages.pipelinePanel.saveNameLabel), "   ");
    expect(button.disabled).toBe(true);
  });

  it("saves the trimmed name and clears the input", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    const input = screen.getByLabelText(messages.pipelinePanel.saveNameLabel) as HTMLInputElement;
    await user.type(input, "  My State  ");
    await user.click(screen.getByRole("button", { name: messages.common.save }));
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).toHaveBeenCalledWith("My State");
    expect(input.value).toBe("");
  });
});

describe("PipelinePanel rename", () => {
  it("opens the inline editor and calls onRename with the new name", async () => {
    const user = userEvent.setup();
    const pipeline = makePipeline();
    const handlers = renderPanel({ pipelines: [pipeline] });

    await user.click(
      screen.getByRole("button", {
        name: `${pipeline.name}${messages.pipelinePanel.renameLabel}`,
      }),
    );

    const input = screen.getByLabelText(messages.pipelinePanel.renamePrompt) as HTMLInputElement;
    expect(input.value).toBe(pipeline.name);
    await user.clear(input);
    await user.type(input, "Renamed State");

    const item = listItemFor(pipeline);
    await user.click(within(item).getByRole("button", { name: messages.common.save }));

    expect(handlers.onRename).toHaveBeenCalledTimes(1);
    expect(handlers.onRename).toHaveBeenCalledWith(pipeline, "Renamed State");
    // Editor closes again.
    expect(screen.queryByLabelText(messages.pipelinePanel.renamePrompt)).toBeNull();
  });
});

describe("PipelinePanel run", () => {
  const filterPipeline = () =>
    makePipeline({
      id: "pl-filter",
      name: "With Filter",
      nodes: [
        makeNode(),
        makeNode({ id: "n-filter", node_type: "filter", name: "Slice", input_id: "n-reader" }),
      ],
    });

  it("only renders the run button for pipelines containing a filter node", () => {
    const plain = makePipeline();
    const filtered = filterPipeline();
    renderPanel({ pipelines: [plain, filtered] });

    expect(
      screen.queryByRole("button", { name: `${plain.name}${messages.pipelinePanel.runLabel}` }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: `${filtered.name}${messages.pipelinePanel.runLabel}` }),
    ).toBeDefined();
  });

  it("disables run when the server runner is unavailable", () => {
    const filtered = filterPipeline();
    renderPanel({ pipelines: [filtered], serverRunAvailable: false });
    const button = screen.getByRole("button", {
      name: `${filtered.name}${messages.pipelinePanel.runLabel}`,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onRun with the pipeline when enabled", async () => {
    const user = userEvent.setup();
    const filtered = filterPipeline();
    const handlers = renderPanel({ pipelines: [filtered] });
    await user.click(
      screen.getByRole("button", { name: `${filtered.name}${messages.pipelinePanel.runLabel}` }),
    );
    expect(handlers.onRun).toHaveBeenCalledTimes(1);
    expect(handlers.onRun).toHaveBeenCalledWith(filtered);
  });
});

describe("PipelinePanel delete", () => {
  it("calls onDelete with the pipeline", async () => {
    const user = userEvent.setup();
    const pipeline = makePipeline();
    const handlers = renderPanel({ pipelines: [pipeline] });
    await user.click(
      screen.getByRole("button", {
        name: `${pipeline.name}${messages.pipelinePanel.deleteLabel}`,
      }),
    );
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledWith(pipeline);
  });
});
