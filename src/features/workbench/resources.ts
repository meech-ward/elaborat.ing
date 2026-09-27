import { exportDrawingSvg } from "@/features/drawings/export.ts";
import { parseDrawingFile } from "@/features/drawings/parse.ts";
import type { DrawingScene } from "@/features/drawings/types.ts";
import { compileD2Diagram } from "@/features/structured/compiler";
import { sidecarPathFor } from "@/features/structured/structuredClient";
import { nativePathFor, projectDiagramArtifact, readDiagramCompanion } from "./diagramArtifact";
import type { WorkspaceStore } from "./workspaceStore";

/**
 * Pictures of drawings and diagrams embedded in a note. The workbench reads
 * the saved files, makes the SVG here, and posts only the SVG into the
 * isolated note frame, which never sees file bytes or storage.
 */

/**
 * Defense in depth: generated SVG must not carry scripts or handlers. The
 * exporter's inline font bytes stay, so previews keep their typography; the
 * frame's `font-src data:` allows them and still blocks network fonts.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}

/** SVG for a drawing file's content; throws a readable error. */
export async function drawingSvgForContent(content: string, filename: string): Promise<string> {
  return sanitizeSvg(await exportDrawingSvg(parseDrawingFile(content, filename).scene));
}

/**
 * SVG for a saved diagram, from the same saved artifact the diagram view
 * shows, in the colours `present` gives it (the palette's diagram fills,
 * as the canvas shows them: useCanvasPresentation).
 */
export async function diagramSvgForWorkspace(
  source: string,
  path: string,
  client: Pick<WorkspaceStore, "read">,
  present: (scene: DrawingScene) => DrawingScene = (scene) => scene,
): Promise<string> {
  const nativePath = nativePathFor(path);
  const [native, sidecar] = await Promise.all([readDiagramCompanion(client, nativePath), readDiagramCompanion(client, sidecarPathFor(path))]);
  const result = await projectDiagramArtifact({
    source,
    nativePath,
    nativeContent: native?.savedContent ?? null,
    sidecarContent: sidecar?.savedContent ?? null,
    compile: async () => {
      const compiled = await compileD2Diagram(source);
      return compiled.ok ? { diagram: compiled.diagram, error: null } : { diagram: null, error: compiled.error };
    },
  });
  if (!result.ok && !result.persistedScene) throw new Error(result.diagnostics[0]?.message ?? "Diagram unavailable");
  return sanitizeSvg(await exportDrawingSvg(present(result.scene)));
}
