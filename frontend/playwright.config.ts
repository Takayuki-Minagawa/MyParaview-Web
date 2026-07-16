import { defineConfig } from "@playwright/test";

/** E2E smoke: real FastAPI backend (dev auth, temp data root) + Vite dev server.
 * Run with `npm run e2e`. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "cd ../backend && PVWEB_AUTH_MODE=dev PVWEB_ALLOW_INSECURE_DEV_AUTH=1 "
        + "PVWEB_DATA_ROOT=$(mktemp -d /tmp/pvweb-e2e.XXXXXX) "
        + "./.venv/bin/python -m uvicorn app.main:app --port 8000",
      url: "http://localhost:8000/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
