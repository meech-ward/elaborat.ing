import { exportDrawingSvg } from "@/features/drawings/export.ts";
import type { DrawingScene } from "@/features/drawings/types.ts";
import { compileD2Diagram } from "@/features/structured/compiler";
import { sidecarPathFor } from "@/features/structured/structuredClient";
import { nativePathFor, projectDiagramArtifact, readDiagramCompanion } from "./diagramArtifact";
import { sanitizeSvg } from "./resources";
import type { WorkspaceStore } from "./workspaceStore";

/** resources.ts's `diagramSvgForWorkspace`, in a chunk of its own: see there. */
export async function diagramSvg(
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
