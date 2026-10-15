import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import type { CameraState } from "../../types";
import { CameraSection, cameraAsText, parseCameraDraft } from "./CameraSection";

const messages = MESSAGES.en;
const camera: CameraState = {
  position: [0, -10, 0],
  focal_point: [0, 0, 0],
  view_up: [0, 0, 1],
  parallel_scale: 2.5,
  parallel_projection: false,
};

function renderSection(state: CameraState | null = camera) {
  const onApply = vi.fn();
  const onResetCamera = vi.fn();
  render(
    <MessagesProvider language="en">
      <CameraSection cameraState={state} onApply={onApply} onResetCamera={onResetCamera} />
    </MessagesProvider>,
  );
  return { onApply, onResetCamera };
}

describe("CameraSection (R-03)", () => {
  it("shows the live camera values and applies edited numbers", async () => {
    const user = userEvent.setup();
    const { onApply } = renderSection();
    const positionY = screen.getByLabelText(`${messages.camera.position} Y`);
    expect(positionY).toHaveValue(-10);
    await user.clear(positionY);
    await user.type(positionY, "-20{Enter}");
    expect(onApply).toHaveBeenCalledWith({ ...camera, position: [0, -20, 0] });
  });

  it("explains invalid input instead of applying it", async () => {
    const user = userEvent.setup();
    const { onApply } = renderSection();
    const upZ = screen.getByLabelText(`${messages.camera.viewUp} Z`);
    await user.clear(upZ);
    await user.type(upZ, "0");
    await user.click(screen.getByRole("button", { name: messages.common.apply }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(messages.camera.invalid);
    expect(upZ).toHaveAttribute("aria-invalid", "true");
  });

  it("disables editing without a camera and wires the reset action", async () => {
    const user = userEvent.setup();
    const { onResetCamera } = renderSection(null);
    expect(screen.getByText(messages.camera.noCamera)).toBeTruthy();
    expect(screen.getByLabelText(`${messages.camera.position} X`)).toBeDisabled();
    await user.click(screen.getByRole("button", { name: messages.properties.resetCamera }));
    expect(onResetCamera).toHaveBeenCalled();
  });
});

describe("parseCameraDraft / cameraAsText", () => {
  const draft = {
    position: ["1", "2", "3"] as [string, string, string],
    focal_point: ["0", "0", "0"] as [string, string, string],
    view_up: ["0", "0", "1"] as [string, string, string],
    parallel_scale: "1.5",
    parallel_projection: true,
  };

  it("parses finite values and rejects degenerate cameras", () => {
    expect(parseCameraDraft(draft)).toEqual({
      position: [1, 2, 3], focal_point: [0, 0, 0], view_up: [0, 0, 1],
      parallel_scale: 1.5, parallel_projection: true,
    });
    expect(parseCameraDraft({ ...draft, position: ["0", "0", "0"] })).toBeNull();
    expect(parseCameraDraft({ ...draft, view_up: ["0", "0", "0"] })).toBeNull();
    expect(parseCameraDraft({ ...draft, parallel_scale: "0" })).toBeNull();
    expect(parseCameraDraft({ ...draft, focal_point: ["x", "0", "0"] })).toBeNull();
    expect(parseCameraDraft({ ...draft, parallel_scale: "" })).toBeNull();
  });

  it("formats the camera as line-oriented text", () => {
    expect(cameraAsText(camera)).toBe([
      "position: 0, -10, 0",
      "focal_point: 0, 0, 0",
      "view_up: 0, 0, 1",
      "parallel_scale: 2.5",
      "parallel_projection: false",
    ].join("\n"));
  });
});
