import { parseDrawingFile } from "@/features/drawings/parse.ts";
import type { DrawingScene } from "@/features/drawings/index.ts";
import type { D2Diagram } from "@/features/structured/types.ts";
import { applySidecar, hashDiagramSource, readSidecarFile, regenerateDiagram, toNativeScene, writeSidecarFile, type RegenerateResult } from "@/features/structured/structuredClient";
import { pendingLabelsFromArtifact, type LabelEdit } from "@/features/structured/labelSync";
import { MissingFileError, type WorkspaceFile, type WorkspaceStore } from "./workspaceStore";

/** A diagram's generated file, or null when it has not been saved yet. */
export async function readDiagramCompanion(client: Pick<WorkspaceStore, "read">, path: string): Promise<WorkspaceFile | null> {
  try {
    return await client.read(path);
  } catch (error) {
    if (error instanceof MissingFileError) return null;
    throw error;
  }
}

/** The `.excalidraw` canvas generated next to a `.d2` source. */
export function nativePathFor(sourcePath: string): string {
  return sourcePath.replace(/\.d2$/i, ".excalidraw");
}

/** The single saved-artifact projection for the diagram view and diagram embeds. */
export async function projectDiagramArtifact(input: {
  source: string;
  nativePath: string;
  nativeContent: string | null;
  sidecarContent: string | null;
  compile: () => Promise<{ diagram: D2Diagram | null; error: string | null }>;
}): Promise<RegenerateResult & { persistedScene: DrawingScene | null; savedSidecarText: string | null; pendingLabels: LabelEdit[] }> {
  // Invalid saved artifacts are not silently replaced with fresh-looking art.
  const persistedScene = input.nativeContent === null ? null : parseDrawingFile(input.nativeContent, input.nativePath).scene;
  const sidecar = readSidecarFile(input.sidecarContent);
  const savedSidecarText = writeSidecarFile(sidecar);
  const pendingLabels = persistedScene && sidecar?.baseline ? pendingLabelsFromArtifact(toNativeScene(persistedScene), sidecar.baseline) : [];
  if (persistedScene && sidecar?.baseline && sidecar.sourceHash === hashDiagramSource(input.source)) {
    return { ok: true, scene: persistedScene, baseline: sidecar.baseline, diagnostics: [], conflicts: [], persistedScene, savedSidecarText, pendingLabels };
  }
  const { diagram, error } = await input.compile();
  const result = await regenerateDiagram(diagram, error, {
    source: input.source,
    prior: persistedScene ? { baseline: sidecar?.baseline ?? null, scene: persistedScene } : null,
    baseScene: persistedScene,
  });
  // Old baseline-free sidecars remain supported; the native companion owns
  // current overrides when a baseline exists, so never apply stale values twice.
  if (sidecar && !sidecar.baseline) {
    const applied = applySidecar(result.scene, sidecar, result.baseline);
    result.scene = applied.scene;
    result.diagnostics.push(...applied.diagnostics);
  }
  return { ...result, persistedScene, savedSidecarText, pendingLabels };
}
