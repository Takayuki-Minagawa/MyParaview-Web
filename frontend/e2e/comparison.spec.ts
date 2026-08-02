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

  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".viewer-canvas")).toHaveCount(1);

  // A second mount proves the released context slot is reusable rather than
  // leaking until the browser's context limit is reached.
  await compare.click();
  await expect(page.locator(".viewer-canvas")).toHaveCount(2);
  await expect(page.getByText("The two-view WebGL context limit has been reached.")).toHaveCount(0);
  await expect(page.locator(".error-banner")).toHaveCount(0);
});
