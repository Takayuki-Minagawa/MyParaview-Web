/** Human-readable byte size. */
export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Group a large integer with thousands separators. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString("en-US");
}

/** Render [xmin,xmax,ymin,ymax,zmin,zmax] as compact per-axis extents. */
export function formatBounds(bounds: number[] | null | undefined): string {
  if (!bounds || bounds.length !== 6) return "-";
  const fmt = (v: number) => Number(v.toFixed(3)).toString();
  const [x0, x1, y0, y1, z0, z1] = bounds;
  return `X[${fmt(x0)}, ${fmt(x1)}]  Y[${fmt(y0)}, ${fmt(y1)}]  Z[${fmt(z0)}, ${fmt(z1)}]`;
}
