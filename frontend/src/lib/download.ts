/** Trigger a browser download for an in-memory blob.
 *
 * The object URL is revoked on the next tick: revoking synchronously can
 * cancel the navigation in some browsers, while leaking it pins the blob in
 * memory for the page's lifetime.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Extract the server-provided filename from a fetch Response's
 * Content-Disposition header; ``fallback`` when absent or unparseable. */
export function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : fallback;
}
