import { parseDrawingFile, serializeDrawing, type DrawingScene } from "@/features/drawings/index.ts";

/**
 * Native `.excalidraw` download seam for the drawing view.
 *
 * Always emits standard native JSON via serializeDrawing: an Obsidian
 * wrapper source still downloads plain `{type:excalidraw,...}` JSON, never
 * compressed fence bytes mislabeled `.excalidraw`. Unknown element fields,
 * top-level extras, files/images, styles and geometry survive because the
 * scene object carries them through parse -> serialize untouched.
 */
export function nativeDownloadFilename(path: string): string {
  const base = path.split("/").pop()?.trim() || "drawing";
  const withoutMd = base.endsWith(".md") ? base.slice(0, -3) : base;
  const name = withoutMd.length > 0 ? withoutMd : "drawing";
  return name.endsWith(".excalidraw") ? name : `${name}.excalidraw`;
}

export type NativeDownloadInput = {
  view: "canvas" | "source";
  /** Current authored canvas scene, including unsaved changes. */
  scene: DrawingScene | null;
  /** Current source-pane text; the authority when view === "source". */
  sourceDraft: string;
  path: string;
};

export type NativeDownloadResult =
  | { ok: true; filename: string; text: string }
  | { ok: false; error: string };

/**
 * Build the native download payload from the CURRENT authored drawing.
 * Canvas view serializes the live scene (unsaved edits included). Source
 * view parses the current draft and visibly fails on invalid source; it
 * never silently falls back to the old scene. Pure: no save, no CAS
 * write, no dirty/history change.
 */
export function buildNativeDownload(input: NativeDownloadInput): NativeDownloadResult {
  const filename = nativeDownloadFilename(input.path);
  try {
    if (input.view === "source") {
      const parsed = parseDrawingFile(input.sourceDraft, input.path);
      return { ok: true, filename, text: serializeDrawing(parsed.scene) };
    }
    if (!input.scene) {
      return { ok: false, error: "nothing to export yet: the drawing has no valid scene" };
    }
    return { ok: true, filename, text: serializeDrawing(input.scene) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
