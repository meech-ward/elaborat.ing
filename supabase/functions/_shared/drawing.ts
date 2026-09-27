import LZString from "npm:lz-string@1.5.0"

// Reads a saved Excalidraw scene: a `.excalidraw` file, or an Obsidian
// `.excalidraw.md` whose drawing is in a ```compressed-json (lz-string) or
// ```json fence, as src/features/drawings/parse.ts reads them in the app.
// The MCP server draws the elements; search indexes their text.

export type DrawingElement = Record<string, unknown>

const FENCE = /```(compressed-json|json)\s*\n([\s\S]*?)```/

/** The live elements of a `.excalidraw` file or an Obsidian `.excalidraw.md`. Throws when it is not one. */
export function parseDrawing(content: string): DrawingElement[] {
  const trimmed = content.trim()
  let json = trimmed
  if (!trimmed.startsWith("{")) {
    const fence = FENCE.exec(trimmed)
    if (!fence) throw new Error("no drawing in this file")
    json = fence[1] === "compressed-json" ? LZString.decompressFromBase64(fence[2].replace(/\s+/g, "")) ?? "" : fence[2]
  }
  const scene = JSON.parse(json) as { elements?: unknown }
  if (!scene || !Array.isArray(scene.elements)) throw new Error("no elements in this drawing")
  return scene.elements.filter(
    (element): element is DrawingElement =>
      typeof element === "object" && element !== null && typeof (element as DrawingElement).type === "string" &&
      (element as DrawingElement).isDeleted !== true,
  )
}

/**
 * The text written in a drawing, one entry per text element (labels bound to
 * shapes and arrows are text elements too), in reading order: top to bottom,
 * then left to right. Deleted and empty text is left out.
 */
export function drawingTexts(elements: DrawingElement[]): string[] {
  const coordinate = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  return elements
    .filter((element) => element.type === "text")
    .map((element) => ({
      // originalText is the text as typed; text has the line breaks wrapping added.
      text: String(typeof element.originalText === "string" && element.originalText.trim() ? element.originalText : element.text ?? "").trim(),
      x: coordinate(element.x),
      y: coordinate(element.y),
    }))
    .filter((entry) => entry.text !== "")
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((entry) => entry.text)
}
