/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// GitHub Pages serves project sites from /<repo>/, so the production build
// needs that as its asset base path. Local dev and `vite preview` stay at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.VITE_BASE_PATH ?? "/MyParaview-Web/") : "/",
  plugins: [react()],
  // vtk.js' XML writer stack reaches xmlbuilder2, which imports these Node
  // core APIs. Vite 8 otherwise externalizes them as empty browser modules and
  // the XML readers fail during application bootstrap.
  resolve: {
    alias: {
      events: fileURLToPath(new URL("./node_modules/events/events.js", import.meta.url)),
      url: fileURLToPath(new URL("./node_modules/url/url.js", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 51,
        branches: 45,
        functions: 48,
        statements: 49,
      },
    },
    // Component tests (.test.tsx) need a DOM; lib tests stay on the fast node env.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          globals: true,
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
        },
      },
    ],
  },
}));
