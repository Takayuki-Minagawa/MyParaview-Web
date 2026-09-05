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
      command: "../backend/.venv/bin/python ../scripts/e2e_server.py",
      url: "http://localhost:8000/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --port 5173 --strictPort",
      env: {
        VITE_API_BASE: "http://localhost:8000",
        VITE_OIDC_AUTHORITY: "",
        VITE_OIDC_CLIENT_ID: "",
        VITE_OIDC_REDIRECT_URI: "",
      },
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
