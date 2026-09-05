import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/tests/data/sample_surface.vtp");

test("display styling and projection render, undo, and survive saved pipeline restoration", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("pvweb-language", "en"));
  await page.goto("/");
  await page.getByPlaceholder("New project name").fill(`display-${Date.now()}`);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const upload = page.locator('input[type="file"]').first();
  await expect(upload).toBeEnabled();
  await upload.setInputFiles(fixture);
  await expect(page.locator(".dataset-select-button").filter({ hasText: "sample_surface.vtp" }).getByText("Ready"))
    .toBeVisible({ timeout: 20_000 });
  const canvas = page.locator(".viewer-canvas canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Iso", exact: true }).click();
  const plain = await canvas.screenshot();
  await page.getByRole("radio", { name: "Surface With Edges", exact: true }).check();
  await page.getByLabel("Edge color", { exact: true }).fill("#00ff00");
  await page.getByLabel("Solid color", { exact: true }).fill("#ff8800");
  await page.getByLabel("Line width", { exact: true }).fill("3");
  await expect.poll(async () => !(await canvas.screenshot()).equals(plain)).toBe(true);

  const projection = page.getByRole("button", { name: "Parallel projection", exact: true });
  await projection.click();
  await expect(projection).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(projection).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(projection).toHaveAttribute("aria-pressed", "true");

  await page.getByPlaceholder("View state name").fill("styled-view");
  const savedResponse = page.waitForResponse((response) => response.url().endsWith("/pipelines") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await (await savedResponse).json();
  const state = saved.nodes.find((node: { node_type: string }) => node.node_type === "representation").params.view_state;
  expect(state.representation).toBe("surface-with-edges");
  expect(state.display_style).toEqual({ solid_color: "#ff8800", edge_color: "#00ff00", point_size: 7, line_width: 3 });
  expect(state.camera.parallel_projection).toBe(true);

  await page.getByRole("radio", { name: "Points", exact: true }).check();
  await page.getByLabel("Point size", { exact: true }).fill("15");
  await projection.click();
  await page.getByRole("button", { name: /styled-view restore/ }).click();
  await expect(page.getByRole("radio", { name: "Surface With Edges", exact: true })).toBeChecked();
  await expect(projection).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Point size", { exact: true })).toHaveValue("7");
  await expect(page.getByLabel("Solid color", { exact: true })).toHaveValue("#ff8800");

  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.locator('.comparison-pane button').filter({ hasText: "Parallel projection" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Parallel projection", exact: true }).nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Parallel projection", exact: true }).nth(1).click();
  await expect(page.getByRole("button", { name: "Parallel projection", exact: true }).first()).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset camera", exact: true }).click();
  await page.screenshot({ path: "test-results/display-style.png", fullPage: true });
});
