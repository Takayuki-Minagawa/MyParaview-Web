import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VTP_FIXTURE = path.resolve(here, "../../backend/tests/data/sample_surface.vtp");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("pvweb-language", "en"));
});

test("2-up comparison creates and releases only the secondary view", async ({ page }) => {
  await page.goto("/");
  const projectName = `compare-${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.locator(".panel-left select").first().locator("option:checked"),
  ).toHaveText(projectName);

  const upload = page.locator('input[type="file"]').first();
  await expect(upload).toBeEnabled();
  await upload.setInputFiles(VTP_FIXTURE);
  const datasetRow = page.locator(".dataset-select-button").filter({ hasText: "sample_surface.vtp" });
  await expect(datasetRow.getByText("Ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Front" })).toBeVisible({ timeout: 20_000 });

  const compare = page.getByRole("button", { name: "Compare", exact: true });
  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".comparison-pane")).toHaveCount(2);
  await expect(page.locator(".viewer-canvas")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Sync cameras" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Right dataset")).toHaveValue(/.+/);

  const primaryCanvas = page.locator(".comparison-primary .viewer-canvas canvas");
  const secondaryCanvas = page.locator(".comparison-secondary .viewer-canvas canvas");
  await expect(primaryCanvas).toBeVisible();
  await expect(secondaryCanvas).toBeVisible();
  const beforeMove = await primaryCanvas.screenshot();
  const box = await primaryCanvas.boundingBox();
  if (!box) throw new Error("Primary comparison canvas has no bounding box");
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const current = await primaryCanvas.screenshot();
    return !current.equals(beforeMove);
  }).toBe(true);
  await expect.poll(async () => {
    return page.locator(".comparison-pane .viewer-canvas canvas").evaluateAll((elements) => {
      const canvases = elements as HTMLCanvasElement[];
      if (canvases.length !== 2) return 1;
      const width = Math.min(canvases[0].width, canvases[1].width);
      const height = Math.min(canvases[0].height, canvases[1].height);
      if (width === 0 || height === 0) return 1;
      const pixels = canvases.map((canvas) => {
        const copy = document.createElement("canvas");
        copy.width = width;
        copy.height = height;
        const context = copy.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Could not create comparison image buffer");
        context.drawImage(canvas, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      });
      let difference = 0;
      for (let index = 0; index < pixels[0].length; index += 4) {
        difference += Math.abs(pixels[0][index] - pixels[1][index]);
        difference += Math.abs(pixels[0][index + 1] - pixels[1][index + 1]);
        difference += Math.abs(pixels[0][index + 2] - pixels[1][index + 2]);
      }
      return difference / ((pixels[0].length / 4) * 3 * 255);
    });
  }).toBeLessThan(0.02);

  // Repeatedly release and reacquire the secondary slot. This catches WebGL
  // contexts that survive unmount and only fail after several toggles.
  for (let index = 0; index < 10; index += 1) {
    await compare.click();
    await expect(compare).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".viewer-canvas")).toHaveCount(1);
    await compare.click();
    await expect(compare).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".viewer-canvas")).toHaveCount(2);
  }
  await expect(page.getByText("The two-view WebGL context limit has been reached.")).toHaveCount(0);
  await expect(page.locator(".error-banner")).toHaveCount(0);
});
