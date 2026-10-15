/**
 * A D2 diagram drawn in the chat card, where the app has not drawn it from
 * its source yet: it has no canvas, or its source changed since. From what
 * the server sends (toolResult.ts `diagrams`), it is laid out by the app's
 * own D2 code (compiler.ts, which runs D2's engine in the card's worker:
 * d2Engine.ts), merged with the canvas and layout record the app saved, as
 * the app does when it opens the diagram (projectDiagramArtifact), and drawn
 * as the server draws the canvas the app saves (parseDrawing, drawingSvg).
 * So it looks as it will once the app has drawn it. Nothing is saved.
 */
import { compileD2Diagram, getSharedD2 } from "@/features/structured/compiler"
import { nativePathFor, projectDiagramArtifact } from "@/features/workbench/diagramArtifact"
import { drawingSvg, MAX_SVG_CHARS, parseDrawing } from "../../../supabase/functions/mcp-server/tools/drawingSvg.ts"
import type { DiagramSource } from "../embedText"
import type { D2 } from "./d2Engine"

/** Starts D2's engine, or keeps it running a while longer, for a diagram on its way. */
export function startEngine(): void {
  // In the card's build the shared instance is the card's own engine (d2Engine.ts).
  getSharedD2().then(
    (d2) => (d2 as D2).start(),
    () => {},
  )
}

/** The diagram at `path` as SVG; throws when it cannot be laid out or drawn. */
export async function drawDiagram(path: string, { source, canvas, layout }: DiagramSource): Promise<string> {
  const result = await projectDiagramArtifact({
    source,
    nativePath: nativePathFor(path),
    nativeContent: canvas ?? null,
    sidecarContent: layout ?? null,
    compile: async () => {
      const compiled = await compileD2Diagram(source)
      return compiled.ok ? { diagram: compiled.diagram, error: null } : { diagram: null, error: compiled.error }
    },
  })
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "The diagram could not be laid out.")
  const drawn = drawingSvg(parseDrawing(JSON.stringify({ elements: result.scene.elements })), MAX_SVG_CHARS, { diagram: true })
  if (!("svg" in drawn)) throw new Error(drawn.problem === "empty" ? "The diagram is empty." : "The diagram is too big to show here.")
  return drawn.svg
}
