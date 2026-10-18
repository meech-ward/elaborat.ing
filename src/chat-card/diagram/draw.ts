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

/**
 * A diagram drawn, as SVG, or why it was not: its source does not compile or
 * lay out (`source`), D2's engine does not run here (`engine`), or its
 * drawing is empty or too big to show (`drawing`); with what D2 or the
 * drawing said.
 */
export type Drawn = { svg: string } | NotDrawn
export type NotDrawn = { problem: "source" | "engine" | "drawing"; message: string }

/** A diagram that lays out wherever D2's engine runs. */
const SURE = "a"

/**
 * D2's message for a source with errors, as plain text: where it lists them
 * (as JSON, each at its line in `index.d2`, the file it compiles), each
 * error's message at its line in the diagram's own file.
 */
function plainErrors(path: string, message: string): string {
  try {
    const errors: unknown = JSON.parse(message)
    if (Array.isArray(errors) && errors.length > 0 && errors.every((error) => typeof error?.errmsg === "string")) {
      return errors.map((error: { errmsg: string }) => error.errmsg.replace(/^index\.d2:/, `${path}:`)).join("; ")
    }
  } catch {
    // Not a list: D2's message as it is.
  }
  return message
}

/** The diagram at `path` as SVG, or why it could not be drawn. */
export async function drawDiagram(path: string, { source, canvas, layout }: DiagramSource): Promise<Drawn> {
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
  if (!result.ok) {
    const message = result.diagnostics[0]?.message ?? "The diagram could not be laid out."
    // Where the engine does not run, every source fails as one with an error does: a diagram that surely lays out tells them apart.
    return (await compileD2Diagram(SURE)).ok ? { problem: "source", message: plainErrors(path, message) } : { problem: "engine", message }
  }
  const drawn = drawingSvg(parseDrawing(JSON.stringify({ elements: result.scene.elements })), MAX_SVG_CHARS, { diagram: true })
  if (!("svg" in drawn)) return { problem: "drawing", message: drawn.problem === "empty" ? "The diagram is empty." : "The diagram is too big to show here." }
  return { svg: drawn.svg }
}
