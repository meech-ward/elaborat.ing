/**
 * Reading a file while an agent is still writing it, for the chat card's live
 * view (mount.ts): the host sends the tool's input so far, many times, each
 * time the whole of it (MCP Apps `ui/notifications/tool-input-partial`). No
 * schema library and no DOM, so the tests run them on their own.
 */

/** A drawing's element, as the scene has it. */
export type SceneElement = Record<string, unknown>

export type DrawingScanner = {
  /**
   * Reads the drawing so far and returns the elements it completed since the
   * last read. `restarted`: the content no longer began with what was read
   * before, so it read it again from the start and every element is new.
   */
  read(content: string): { added: SceneElement[]; restarted: boolean }
  /** Every element completed so far, in the file's order. */
  readonly elements: readonly SceneElement[]
  /** The drawing is compressed (an Obsidian `compressed-json` fence): nothing to read until it is saved. */
  readonly compressed: boolean
}

/** Where an Obsidian drawing's scene starts: after its fence, as the server's parseDrawing finds it. */
const FENCE = /```(compressed-json|json)\s*\n/

/**
 * Reads an Excalidraw scene (a `.excalidraw` file, or the json fence of an
 * `.excalidraw.md`) as it is written: it goes through the text once, minding
 * strings and their escapes, finds the scene's top-level `"elements": [`,
 * and parses each element once its closing brace has come. Deleted elements
 * and anything without a type are left out, as the server leaves them out.
 */
export function drawingScanner(): DrawingScanner {
  let seen = ""
  let at = 0
  let started = false
  let depth = 0
  let inString = false
  let escaped = false
  let stringStart = 0
  // The last string the scene's own object held, and whether a colon came after it.
  let key: string | null = null
  let colon = false
  let inElements = false
  let elementStart = -1
  let done = false
  let compressed = false
  let elements: SceneElement[] = []

  const reset = () => {
    seen = ""
    at = 0
    started = inString = escaped = colon = inElements = done = compressed = false
    depth = 0
    key = null
    elementStart = -1
    elements = []
  }

  /** Where the scene's opening brace may be, or -1 until it can be known. */
  const sceneStart = (content: string): number => {
    const first = content.search(/\S/)
    if (first < 0) return -1
    if (content[first] === "{") return first
    const fence = FENCE.exec(content)
    if (!fence) return -1
    if (fence[1] === "compressed-json") {
      compressed = done = true
      return -1
    }
    return fence.index + fence[0].length
  }

  const complete = (content: string, end: number, added: SceneElement[]) => {
    try {
      const element: unknown = JSON.parse(content.slice(elementStart, end + 1))
      if (typeof element === "object" && element !== null && typeof (element as SceneElement).type === "string" && (element as SceneElement).isDeleted !== true) {
        elements.push(element as SceneElement)
        added.push(element as SceneElement)
      }
    } catch {
      // Not JSON after all: the server will not draw it either.
    }
  }

  return {
    read(content) {
      const restarted = seen !== "" && !content.startsWith(seen)
      if (restarted) reset()
      seen = content
      const added: SceneElement[] = []
      if (done) return { added, restarted }
      if (!started) {
        const start = sceneStart(content)
        if (start < 0) return { added, restarted }
        started = true
        at = start
      }
      for (; at < content.length && !done; at++) {
        const char = content[at]
        if (inString) {
          if (escaped) escaped = false
          else if (char === "\\") escaped = true
          else if (char === '"') {
            inString = false
            if (depth === 1) {
              key = content.slice(stringStart + 1, at)
              colon = false
            }
          }
          continue
        }
        switch (char) {
          case '"':
            inString = true
            stringStart = at
            break
          case ":":
            if (depth === 1) colon = key !== null
            break
          case ",":
            if (depth === 1) key = null
            break
          case "{":
            if (depth === 0) depth = 1
            else {
              if (inElements && depth === 2) elementStart = at
              depth++
            }
            break
          case "[":
            if (depth === 1 && key === "elements" && colon) inElements = true
            if (depth === 1) key = null
            depth++
            break
          case "}":
          case "]":
            depth--
            if (inElements && depth === 2 && char === "}" && elementStart >= 0) {
              complete(content, at, added)
              elementStart = -1
            } else if (inElements && depth === 1) {
              // The elements are all there; the rest of the scene is not drawn.
              inElements = false
              done = true
            } else if (depth <= 0) done = true
            break
          default:
            // Anything but whitespace before the scene's brace: not a scene.
            if (depth === 0 && !/\s/.test(char)) done = true
        }
      }
      return { added, restarted }
    },
    get elements() {
      return elements
    },
    get compressed() {
      return compressed
    },
  }
}

/**
 * A note's text so far, ready to render: a frontmatter block that has not
 * closed yet is held back (it would show as text), and so is a tag still
 * being written at the end (`<Drawing src="art/fl`), until its `>` comes.
 */
export function noteTail(text: string): string {
  // A note may open with a frontmatter fence: until it closes, nothing shows.
  if (/^(-{1,3}|\+{1,3})$/.test(text)) return ""
  const fence = /^(---|\+\+\+)[ \t]*\r?\n/.exec(text)
  if (fence) {
    const close = new RegExp(`\\n${fence[1] === "---" ? "---" : "\\+\\+\\+"}[ \\t]*(\\r?\\n|$)`).exec(text.slice(fence[0].length - 1))
    if (!close) return ""
  }
  // A tag still open at the end: no `>` after its `<`, and no blank line (a tag has none).
  const open = text.lastIndexOf("<")
  if (open >= 0 && /^<([A-Za-z/!]|$)/.test(text.slice(open, open + 2))) {
    const rest = text.slice(open)
    if (!rest.includes(">") && !/\n[ \t]*\n/.test(rest)) return text.slice(0, open)
  }
  return text
}
