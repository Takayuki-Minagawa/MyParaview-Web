export interface BrowserCapabilities {
  webgpu: boolean;
  wasm: boolean;
  renderer: "vtk.js WebGL";
}

export function detectBrowserCapabilities(): BrowserCapabilities {
  const gpuNavigator = (
    typeof navigator === "undefined" ? {} : navigator
  ) as Navigator & { gpu?: unknown };
  return {
    webgpu: Boolean(gpuNavigator.gpu),
    wasm: typeof WebAssembly !== "undefined" && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    // vtk.js remains the supported renderer. WebGPU is surfaced as an R&D
    // capability rather than silently changing the rendering backend.
    renderer: "vtk.js WebGL",
  };
}
