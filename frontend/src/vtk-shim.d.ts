// Fallback ambient types so `tsc --noEmit` succeeds even where @kitware/vtk.js
// ships partial/loosely-typed deep import paths. Vite/esbuild transpiles vtk.js
// regardless of this; the shim only relaxes the standalone typecheck.
declare module "@kitware/vtk.js/*";

interface ImportMeta {
  readonly env?: Record<string, string | undefined>;
}
