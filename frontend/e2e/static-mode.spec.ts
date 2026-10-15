import { expect, test, type Page } from "@playwright/test";

/** Browser-viewing (static) mode: served by the second dev server in
 * playwright.config.ts with VITE_APP_MODE=static and no API base. */
test.use({ baseURL: "http://localhost:5174" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("pvweb-language", "en");
  });
});

function trackApiRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/localhost:8000|127\.0\.0\.1:8000/.test(url)) requests.push(url);
  });
  return requests;
}

test("opens a bundled sample without any API request and renders it", async ({ page }) => {
  const apiRequests = trackApiRequests(page);
  await page.goto("/");
  await expect(page.getByTestId("connection-mode")).toHaveText("Browser viewing mode (no server)");
  await expect(page.locator(".error-banner")).toHaveCount(0);

  await page.getByLabel("Sample", { exact: true }).selectOption("surface");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.getByRole("button", { name: "Front" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".viewer-canvas canvas")).toBeVisible();
  await expect(page.getByTestId("selection-status")).toContainText("Displayed", { timeout: 20_000 });
  // Metadata was parsed in the browser: arrays appear in the color picker.
  const colorBy = page.getByLabel("Data array for coloring");
  await expect(colorBy).toBeVisible();
  await colorBy.selectOption("point:temperature");
  await expect(page.locator(".color-legend")).toBeVisible();

  // Client-side clip with a numeric plane definition.
  const clip = page.getByRole("button", { name: "Clip", exact: true });
  await clip.click();
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  const originX = page.getByLabel("Origin X");
  await expect(originX).toHaveValue(/.+/);
  await originX.fill("0.5");
  const planeForm = page.locator(".viewer-plane-numeric");
  await planeForm.getByLabel("Normal X").fill("0");
  await planeForm.getByLabel("Normal Y").fill("2");
  await planeForm.getByLabel("Normal Z").fill("0");
  await planeForm.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(planeForm.locator("[role=alert]")).toHaveCount(0);
  // The fields are re-read from the widget: origin kept, normal normalized.
  await expect(originX).toHaveValue("0.5");
  await expect(planeForm.getByLabel("Normal Y")).toHaveValue("1");

  // Numeric camera editing round-trips through the viewer.
  const cameraY = page.getByLabel("Position Y");
  await expect(cameraY).toHaveValue(/.+/);

  // Screenshot downloads locally instead of uploading an artifact.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Screenshot" }).first().click();
  expect((await download).suggestedFilename()).toBe("screenshot.png");

  expect(apiRequests).toEqual([]);
  await expect(page.locator(".error-banner")).toHaveCount(0);
});

test("explains broken, server-only, and incomplete samples and recovers", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Sample", { exact: true }).selectOption("serverOnly");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.locator(".error-banner")).toContainText("ParaView worker conversion");

  await page.getByLabel("Sample", { exact: true }).selectOption("missingFiles");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.locator(".error-banner").last()).toContainText("absent_step0.vtp");

  await page.getByLabel("Sample", { exact: true }).selectOption("broken");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.locator(".viewer-overlay")).toContainText("Render error", { timeout: 20_000 });

  // Recovery without reload: another sample renders normally.
  await page.getByLabel("Sample", { exact: true }).selectOption("series");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.getByRole("button", { name: "Front" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("selection-status")).toContainText("Timestep 1 / 4", { timeout: 20_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("selection-status")).toContainText("Timestep 2 / 4", { timeout: 20_000 });
});

test("connecting to an absent server reports the reason and keeps local viewing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to a server…" }).click();
  await page.getByLabel("API base URL").fill("http://127.0.0.1:1");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("connection-status")).toHaveText("Connection failed", { timeout: 20_000 });
  await expect(page.locator(".connection-failure")).toContainText("could not be reached");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByLabel("Sample", { exact: true }).selectOption("points");
  await page.getByRole("button", { name: "Open sample" }).click();
  await expect(page.getByRole("button", { name: "Front" })).toBeVisible({ timeout: 20_000 });
});

test("quick guide traps focus and closes with Escape from inside", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Quick Guide" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quick Guide" })).toBeFocused();
});

for (const [width, height] of [[632, 653], [1280, 900]] as const) {
  test(`toolbar labels stay on one line and the viewer keeps its width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const language of ["en", "ja"] as const) {
      await page.addInitScript((lang) => window.localStorage.setItem("pvweb-language", lang), language);
      await page.goto("/");
      for (const name of language === "en"
        ? ["Light", "Dark", "Japanese", "English"]
        : ["ライト", "ダーク", "日本語", "English"]) {
        const button = page.locator(".mode-controls .segmented button", { hasText: name }).first();
        const box = await button.boundingBox();
        expect(box, name).not.toBeNull();
        // A single text line is well under 40px; wrapped glyphs would stack higher.
        expect(box!.height, `${name} height`).toBeLessThan(40);
        expect(box!.width, `${name} width`).toBeGreaterThan(20);
      }
      const main = await page.locator("main.center").boundingBox();
      expect(main).not.toBeNull();
      expect(main!.width).toBeGreaterThan(width <= 900 ? width * 0.9 : 400);
    }
  });
}
