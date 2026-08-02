/**
 * Explicit budget for vtk.js GenericRenderWindow instances.
 *
 * A GenericRenderWindow owns a WebGL context. Browser limits vary and a lost
 * context fails silently on some GPUs, so the application never keeps more
 * than the two contexts required by comparison mode. Leases are idempotent so
 * React effect cleanup (including StrictMode's development replay) is safe.
 */
export interface ViewerContextLease {
  readonly owner: string;
  readonly released: boolean;
  release: () => void;
}

export interface ViewerContextPool {
  readonly maximum: number;
  readonly activeCount: number;
  tryAcquire: (owner: string) => ViewerContextLease | null;
}

export function createViewerContextPool(maximum: number): ViewerContextPool {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError("Viewer context limit must be a positive integer");
  }

  const active = new Set<symbol>();

  return {
    maximum,
    get activeCount() {
      return active.size;
    },
    tryAcquire(owner: string) {
      if (active.size >= maximum) return null;
      const token = Symbol(owner);
      active.add(token);
      let released = false;
      return {
        owner,
        get released() {
          return released;
        },
        release() {
          if (released) return;
          released = true;
          active.delete(token);
        },
      };
    },
  };
}

/** One primary view plus one comparison view; no hidden spare contexts. */
export const viewerContextPool = createViewerContextPool(2);
