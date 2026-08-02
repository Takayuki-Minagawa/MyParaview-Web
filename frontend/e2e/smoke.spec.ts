import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VTP_FIXTURE = path.resolve(here, "../../backend/tests/data/sample_surface.vtp");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("pvweb-language", "en");
  });
});

test("upload -> display -> save/restore view state -> stats artifact", async ({ page }) => {
  await page.goto("/");

  // Create a project; the app auto-selects it.
  const projectName = `e2e-${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("select").first()).toHaveValue(/.+/);

  // Upload the VTP fixture; ingest runs and the row flips to Ready.
  await page.locator('input[type="file"]').first().setInputFiles(VTP_FIXTURE);
  const datasetRow = page.locator(".dataset-select-button").filter({ hasText: "sample_surface.vtp" });
  await expect(datasetRow).toBeVisible({ timeout: 20_000 });
  await expect(datasetRow.getByText("Ready")).toBeVisible({ timeout: 20_000 });

  // The viewer considers the dataset renderable: standard-view toolbar shows.
  await expect(page.getByRole("button", { name: "Front" })).toBeVisible({ timeout: 20_000 });
  const canvas = page.locator(".viewer-canvas canvas");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("VTK canvas did not expose a bounding box");
  const canvasCenter = {
    x: canvasBox.x + canvasBox.width / 2,
    y: canvasBox.y + canvasBox.height / 2,
  };
  // The tetra fixture's projected centroid sits left of its bounds centre.
  const modelPoint = {
    x: canvasBox.x + canvasBox.width * 0.4,
    y: canvasCenter.y,
  };
  // Client-side plane tools operate on the already loaded VTP without a job.
  const clipButton = page.getByRole("button", { name: "Clip", exact: true });
  await clipButton.click();
  await expect(clipButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Plane normal Y" }).click();
  await expect(page.getByRole("button", { name: "Plane normal Y" }))
    .toHaveAttribute("aria-pressed", "true");
  // Exercise the plane widget itself, not only its toolbar controls.
  await page.mouse.move(canvasCenter.x, canvasCenter.y);
  await page.mouse.down();
  await page.mouse.move(canvasCenter.x + 24, canvasCenter.y + 12, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Flip", exact: true }).click();
  await page.getByRole("button", { name: "Reset plane" }).click();
  const probeButton = page.getByRole("button", { name: "Probe", exact: true });
  await probeButton.click();
  await expect(probeButton).toHaveAttribute("aria-pressed", "true");
  await expect(clipButton).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(modelPoint.x, modelPoint.y);
  await expect(page.locator(".probe-tooltip")).toBeVisible({ timeout: 10_000 });
  const distanceButton = page.getByRole("button", { name: "Distance", exact: true });
  await distanceButton.click();
  await expect(distanceButton).toHaveAttribute("aria-pressed", "true");
  await expect(probeButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Click two points to measure distance.")).toBeVisible();
  // vtkLineWidget positions its active move handle on pointer movement before
  // each placement click.
  await page.mouse.move(canvasCenter.x - 40, canvasCenter.y, { steps: 4 });
  await page.mouse.click(canvasCenter.x - 40, canvasCenter.y);
  await page.mouse.move(canvasCenter.x + 40, canvasCenter.y, { steps: 4 });
  await page.mouse.click(canvasCenter.x + 40, canvasCenter.y);
  await expect(page.locator(".measurement-readout")).toContainText("Distance:", { timeout: 10_000 });
  // No error banner appeared during the flow.
  await expect(page.locator(".error-banner")).toHaveCount(0);

  // Save the current view state as a pipeline and restore it.
  await page.getByPlaceholder("View state name").fill("smoke-state");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const restoreButton = page.getByRole("button", { name: /smoke-state restore/ });
  await expect(restoreButton).toBeVisible({ timeout: 10_000 });
  await restoreButton.click();
  await expect(page.locator(".error-banner")).toHaveCount(0);

  // Run the statistics job and render its histogram from the artifact.
  await page.getByRole("button", { name: "Compute statistics" }).click();
  await expect(page.getByRole("button", { name: "Show histograms" }))
    .toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Show histograms" }).click();
  await expect(page.locator(".stats-histogram").first()).toBeVisible({ timeout: 10_000 });
});
