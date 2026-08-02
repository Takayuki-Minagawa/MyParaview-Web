import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import { SERVER_FILTER_NAMES, type Dataset } from "../../types";
import { ServerFilterSection } from "./ServerFilterSection";

const messages = MESSAGES.en;

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "mesh.vtp",
    ext: ".vtp",
    size_bytes: 1024,
    status: "ready",
    dataset_type: "PolyData",
    bounds: [0, 2, 0, 4, 0, 6],
    arrays: [
      { name: "temperature", association: "point", num_components: 1, value_range: [0, 100] },
      { name: "stress", association: "cell", num_components: 1, value_range: [1, 5] },
    ],
    created_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

function renderSection(
  onRunFilter = vi.fn(),
  overrides: { serverFilterAvailable?: boolean; dataset?: Dataset } = {},
) {
  render(
    <MessagesProvider language="en">
      <ServerFilterSection
        dataset={overrides.dataset ?? dataset()}
        sliceAxis="Z"
        filterPending={false}
        serverFilterAvailable={overrides.serverFilterAvailable ?? true}
        onRunFilter={onRunFilter}
      />
    </MessagesProvider>,
  );
  return onRunFilter;
}

async function selectFilter(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.selectOptions(screen.getByLabelText(messages.properties.filter), name);
}

describe("ServerFilterSection", () => {
  it("renders all seven canonical filters and keeps execution disabled without pvpython", () => {
    renderSection(vi.fn(), { serverFilterAvailable: false });

    const select = screen.getByLabelText(messages.properties.filter) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      SERVER_FILTER_NAMES,
    );
    expect((
      screen.getByRole("button", { name: messages.properties.runFilter }) as HTMLButtonElement
    ).disabled).toBe(true);
    expect(screen.getByText(messages.properties.workerMissing)).toBeTruthy();
  });

  it("keeps the existing contour request shape", async () => {
    const user = userEvent.setup();
    const onRunFilter = renderSection();

    await user.click(screen.getByRole("button", { name: messages.properties.runFilter }));

    expect(onRunFilter).toHaveBeenCalledWith({
      filter: "contour",
      array: "temperature",
      association: "POINTS",
      value: 0,
    });
  });

  it("runs Cell Data to Point Data without requiring a scalar selection", async () => {
    const user = userEvent.setup();
    const onRunFilter = renderSection(vi.fn(), { dataset: dataset({ arrays: [] }) });

    await selectFilter(user, "cell_to_point");
    await user.click(screen.getByRole("button", { name: messages.properties.runFilter }));

    expect(onRunFilter).toHaveBeenCalledWith({ filter: "cell_to_point" });
  });

  it("submits integer sampling dimensions and rejects an out-of-range value", async () => {
    const user = userEvent.setup();
    const onRunFilter = renderSection();
    await selectFilter(user, "resample");

    const x = screen.getByLabelText(`${messages.properties.resampleDimensions} X`);
    const y = screen.getByLabelText(`${messages.properties.resampleDimensions} Y`);
    const z = screen.getByLabelText(`${messages.properties.resampleDimensions} Z`);
    await user.clear(x);
    await user.type(x, "1");
    expect((
      screen.getByRole("button", { name: messages.properties.runFilter }) as HTMLButtonElement
    ).disabled).toBe(true);
    await user.clear(x);
    await user.type(x, "16");
    await user.clear(y);
    await user.type(y, "24");
    await user.clear(z);
    await user.type(z, "32");
    await user.click(screen.getByRole("button", { name: messages.properties.runFilter }));

    expect(onRunFilter).toHaveBeenCalledWith({
      filter: "resample",
      dimensions: [16, 24, 32],
    });
  });

  it("accepts the resample sample-count boundary and rejects a product above it", async () => {
    const user = userEvent.setup();
    const onRunFilter = renderSection();
    await selectFilter(user, "resample");

    const x = screen.getByLabelText(`${messages.properties.resampleDimensions} X`);
    const y = screen.getByLabelText(`${messages.properties.resampleDimensions} Y`);
    const z = screen.getByLabelText(`${messages.properties.resampleDimensions} Z`);
    for (const input of [x, y, z]) {
      await user.clear(input);
      await user.type(input, "256");
    }

    const runButton = screen.getByRole("button", { name: messages.properties.runFilter });
    expect((runButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(messages.properties.resampleSampleLimitError)).toBeNull();
    await user.click(runButton);
    expect(onRunFilter).toHaveBeenCalledWith({
      filter: "resample",
      dimensions: [256, 256, 256],
    });

    await user.clear(x);
    await user.type(x, "257");

    expect((runButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      messages.properties.resampleSampleLimitError,
    );
    expect(x.getAttribute("aria-invalid")).toBe("true");
    expect(y.getAttribute("aria-invalid")).toBe("true");
    expect(z.getAttribute("aria-invalid")).toBe("true");
  });

  it("submits a bounded decimation target reduction", async () => {
    const user = userEvent.setup();
    const onRunFilter = renderSection();
    await selectFilter(user, "decimate");

    const reduction = screen.getByLabelText(messages.properties.targetReduction);
    await user.clear(reduction);
    await user.type(reduction, "0.75");
    await user.click(screen.getByRole("button", { name: messages.properties.runFilter }));
    expect(onRunFilter).toHaveBeenCalledWith({
      filter: "decimate",
      target_reduction: 0.75,
    });

    await user.clear(reduction);
    await user.type(reduction, "1");
    expect((
      screen.getByRole("button", { name: messages.properties.runFilter }) as HTMLButtonElement
    ).disabled).toBe(true);
  });
});
