import { expect, test } from "@playwright/test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let bundleDirectory: string;

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "pvweb-playback-"));
  for (const filename of ["sample_series.pvd", "series_step0.vtp", "series_step1.vtp"]) {
    await copyFile(path.resolve(here, "../../backend/tests/data", filename), path.join(bundleDirectory, filename));
  }
});
test.afterAll(async () => { await rm(bundleDirectory, { recursive: true, force: true }); });

test("PVD controls navigate, wait for rendering, stop at the end, and pause on load errors", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("pvweb-language", "en"));
  await page.goto("/");
  const projectName = `playback-${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".panel-left select").first().locator("option:checked")).toHaveText(projectName);
  await page.locator('input[webkitdirectory]').setInputFiles(bundleDirectory);
  const datasetRow = page.locator(".dataset-select-button").filter({ hasText: "sample_series.pvd" });
  await expect(datasetRow.getByText("Ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Front", exact: true })).toBeVisible();
  const controls = page.locator(".time-controls");
  await expect(controls).toContainText("step 0 / 1 · t=0");
  await expect(controls.getByLabel("Playback speed")).toHaveValue("1");
  await expect(controls.getByLabel("Loop playback")).toBeChecked();

  await controls.getByRole("button", { name: "Last", exact: true }).click();
  await expect(controls).toContainText("step 1 / 1 · t=1.5");
  await controls.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(controls).toContainText("step 0 / 1 · t=0");
  await controls.getByRole("button", { name: "Next", exact: true }).click();
  await expect(controls).toContainText("step 1 / 1 · t=1.5");
  await controls.getByRole("button", { name: "First", exact: true }).click();
  await controls.getByLabel("Playback speed").selectOption("4");
  await controls.getByLabel("Loop playback").uncheck();

  // Hold the final frame response longer than the selected dwell time. The
  // player must wait for vtk.js to render it before reporting completion.
  let releaseFrame: (() => void) | undefined;
  const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
  await page.route("**/datasets/*/timesteps/1/download", async (route) => {
    await frameGate;
    await route.continue();
  });
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(controls).toContainText("step 1 / 1 · t=1.5");
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  releaseFrame?.();
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await page.unroute("**/datasets/*/timesteps/1/download");

  // Non-looping playback at the end restarts from the first frame, then stops.
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(controls).toContainText("step 0 / 1 · t=0");
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(controls).toContainText("step 1 / 1 · t=1.5");

  await controls.getByRole("button", { name: "First", exact: true }).click();
  await page.route("**/datasets/*/timesteps/1/download", (route) => route.fulfill({
    status: 500, contentType: "text/plain", body: "deliberate playback fixture failure",
  }));
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await expect(page.getByText(/Render error/)).toBeVisible();
});
