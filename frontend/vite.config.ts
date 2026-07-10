/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
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
});
