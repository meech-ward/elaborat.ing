/** Save a blob to the person's downloads under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later tick so the download has started.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save text to the person's downloads under `filename`. */
export function downloadText(text: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename);
}
