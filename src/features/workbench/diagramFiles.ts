import { MissingFileError, type WorkspaceFile, type WorkspaceStore } from "./workspaceStore";

// Where a diagram's generated files live, apart from the code that makes
// them (diagramArtifact.ts), which loads with the diagram view.

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
