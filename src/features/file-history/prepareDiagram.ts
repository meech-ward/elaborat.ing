import { saveDrawingFile } from "../drawings/serialize"
import { compileD2Diagram } from "../structured/compiler"
import { diagramSidecarText } from "../structured/diagramPersistence"
import { projectDiagramArtifact } from "../workbench/diagramArtifact"
import type { WorkspaceFile } from "../workbench/workspaceStore"
import { HistoryRestoreError } from "./errors"

/** Load the diagram operation together, without making shared helpers dynamic entries. */
export async function prepareDiagram(source: string, nativePath: string, native: WorkspaceFile | null, sidecar: WorkspaceFile | null): Promise<{ native: string; sidecar: string }> {
  const result = await projectDiagramArtifact({
    source,
    nativePath,
    nativeContent: native?.savedContent ?? null,
    sidecarContent: sidecar?.savedContent ?? null,
    compile: async () => {
      const compiled = await compileD2Diagram(source)
      return compiled.ok ? { diagram: compiled.diagram, error: null } : { diagram: null, error: compiled.error }
    },
  })
  if (!result.ok) throw new HistoryRestoreError("This version's diagram code does not compile. Nothing was restored.")
  const sidecarText = diagramSidecarText(result.baseline, result.scene)
  if (sidecarText === null) throw new HistoryRestoreError("The diagram's generation baseline is unavailable. Nothing was restored.")
  return { native: saveDrawingFile(result.scene, null).text, sidecar: sidecarText }
}
