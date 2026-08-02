import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const CASES = [
  {
    name: "VTP",
    fixture: path.resolve(here, "../../backend/tests/data/sample_surface.vtp"),
    filename: "sample_surface.vtp",
    cellArray: "cell_id",
    cellValue: /^[0-3]\.000000$/,
  },
  {
    name: "VTU",
    fixture: path.resolve(here, "../../backend/tests/data/sample_unstructured.vtu"),
    filename: "sample_unstructured.vtu",
    cellArray: "region",
    cellValue: /^7\.000000$/,
  },
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("pvweb-language", "en"));
});

for (const scenario of CASES) {
  test(`clip, probe, and distance operate on ${scenario.name}`, async ({ page }) => {
    await page.goto("/");
    const projectName = `interactive-${scenario.name.toLowerCase()}-${Date.now()}`;
    await page.getByPlaceholder("New project name").fill(projectName);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.locator(".panel-left select").first().locator("option:checked"),
    ).toHaveText(projectName);
    const upload = page.locator('input[type="file"]').first();
    await expect(upload).toBeEnabled();
    await upload.setInputFiles(scenario.fixture);

    const datasetRow = page.locator(".dataset-select-button").filter({
      hasText: scenario.filename,
    });
    await expect(datasetRow.getByText("Ready")).toBeVisible({ timeout: 20_000 });
    const canvas = page.locator(".viewer-canvas canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("VTK canvas did not expose a bounding box");
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const modelPoint = { x: box.x + box.width * 0.4, y: center.y };

    const clip = page.getByRole("button", { name: "Clip", exact: true });
    await clip.click();
    await expect(clip).toHaveAttribute("aria-pressed", "true");
    const beforeDrag = await canvas.screenshot();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 28, center.y + 14, { steps: 5 });
    await page.mouse.up();
    const afterDrag = await canvas.screenshot();
    expect(afterDrag.equals(beforeDrag)).toBe(false);

    const probe = page.getByRole("button", { name: "Probe", exact: true });
    await probe.click();
    await page.mouse.click(modelPoint.x, modelPoint.y);
    const tooltip = page.locator(".probe-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    const cellValue = tooltip.locator("dl > div").filter({
      hasText: `cell · ${scenario.cellArray}`,
    }).locator("dd");
    await expect(cellValue).toHaveText(scenario.cellValue);

    await page.getByRole("button", { name: "Distance", exact: true }).click();
    await page.mouse.move(center.x - 40, center.y, { steps: 4 });
    await page.mouse.click(center.x - 40, center.y);
    await page.mouse.move(center.x + 40, center.y, { steps: 4 });
    await page.mouse.click(center.x + 40, center.y);
    const readout = page.locator(".measurement-readout");
    await expect(readout).toContainText("Distance:", { timeout: 10_000 });
    const distance = Number((await readout.textContent())?.split(":")[1]);
    expect(distance).toBeGreaterThan(0);
    await expect(page.locator(".error-banner")).toHaveCount(0);
  });
}
