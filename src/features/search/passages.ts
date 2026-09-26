import remarkFrontmatter from "remark-frontmatter"
import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import remarkParse from "remark-parse"
import { unified } from "unified"

// Turns one file into passages for hybrid search: a passage per heading
// section of a note, or blank-line-separated blocks of a D2 diagram, each short
// enough for the embedding model.

export type Passage = {
  /** Headings above this passage, outermost first. Empty before the first heading. */
  headings: string[]
  /** Plain text to embed and search. */
  text: string
  /** UTF-16 offsets of the passage's span in the original source. */
  start: number
  end: number
}

/** The most UTF-16 code units of text in one passage. */
const MAX_LENGTH = 1500

// Parsing only: nothing in a file is ever evaluated. remark-mdx comes right
// after remark-parse, where @mdx-js/mdx puts it.
const markdown = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkGfm)
  .freeze()
const mdx = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkGfm)
  .freeze()

/** The parts of an mdast node this module reads. */
type Node = {
  type: string
  value?: unknown
  alt?: unknown
  depth?: unknown
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** A piece of text and the span of source it came from. */
type Unit = { text: string; start: number; end: number }

export function extractPassages(path: string, source: string): Passage[] {
  switch (/\.([^./]+)$/.exec(path)?.[1].toLowerCase()) {
    case "md":
      return notePassages(markdown.parse(source))
    case "mdx":
      return notePassages(parseMdx(source))
    case "d2":
      return diagramPassages(source)
    default:
      return []
  }
}

function parseMdx(source: string): Node {
  try {
    return mdx.parse(source)
  } catch {
    // An MDX syntax error, perhaps from a file still being written. Its text
    // is still worth finding, so read it as Markdown.
    return markdown.parse(source)
  }
}

/** A passage per heading section, split further where a section is too long. */
function notePassages(tree: Node): Passage[] {
  const passages: Passage[] = []
  const headings: { depth: number; text: string }[] = []
  let units: Unit[] = []
  const endSection = () => {
    const labels = headings.map((heading) => heading.text).filter((text) => text !== "")
    passages.push(...pack(labels, units, false, (parts) => parts.map((part) => part.text).join("\n")))
    units = []
  }

  for (const node of tree.children ?? []) {
    if (node.type === "heading") {
      endSection()
      const depth = Number(node.depth)
      while (headings.length > 0 && headings[headings.length - 1].depth >= depth) headings.pop()
      headings.push({ depth, text: phrasingText(node.children).trim() })
    } else {
      collectUnits(node, units)
    }
  }
  endSection()
  return passages
}

/**
 * Adds the text of a block to `units`, one unit per paragraph, code block,
 * table row or nested heading, so long sections can split between them.
 */
function collectUnits(node: Node, units: Unit[]): void {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return addUnit(units, node, phrasingText(node.children))
    case "code":
      return addUnit(units, node, typeof node.value === "string" ? node.value : "")
    case "tableRow": {
      const cells = (node.children ?? []).map((cell) => phrasingText(cell.children).trim())
      return addUnit(units, node, cells.join(" | "))
    }
    // Frontmatter, MDX import and export statements, JavaScript expressions,
    // raw HTML, link definitions and thematic breaks hold no prose.
    case "yaml":
    case "toml":
    case "mdxjsEsm":
    case "mdxFlowExpression":
    case "html":
    case "definition":
    case "thematicBreak":
      return
    default:
      // Lists, list items, block quotes, tables, footnotes and JSX elements.
      for (const child of node.children ?? []) collectUnits(child, units)
  }
}

/** The plain text of inline content, leaving out expressions and raw HTML. */
function phrasingText(nodes: Node[] = []): string {
  let text = ""
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "inlineCode":
        text += String(node.value)
        break
      case "break":
        text += "\n"
        break
      case "image":
      case "imageReference":
        if (typeof node.alt === "string") text += node.alt
        break
      case "mdxTextExpression":
      case "html":
      case "footnoteReference":
        break
      default:
        // Emphasis, links, JSX elements and the like: their text.
        text += phrasingText(node.children)
    }
  }
  // Collapse the doubled spaces that dropped expressions and HTML leave.
  return text.replace(/[ \t]+/g, " ")
}

function addUnit(units: Unit[], node: Node, text: string): void {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  const trimmed = text.trim()
  if (trimmed !== "" && start !== undefined && end !== undefined) units.push({ text: trimmed, start, end })
}

/** A D2 file as text, in blocks separated by blank lines. */
function diagramPassages(source: string): Passage[] {
  const blocks: Unit[] = []
  let blockStart = -1
  let blockEnd = -1
  let lineStart = 0
  for (const line of source.split("\n")) {
    if (line.trim() !== "") {
      if (blockStart === -1) blockStart = lineStart
      blockEnd = lineStart + line.length
    } else if (blockStart !== -1) {
      blocks.push(sourceUnit(source, blockStart, blockEnd))
      blockStart = -1
    }
    lineStart += line.length + 1
  }
  if (blockStart !== -1) blocks.push(sourceUnit(source, blockStart, blockEnd))
  return pack([], blocks, true, (parts) => source.slice(parts[0].start, parts[parts.length - 1].end))
}

/** The source between `start` and `end`, without surrounding whitespace. */
function sourceUnit(source: string, start: number, end: number): Unit {
  while (start < end && /\s/.test(source[start])) start++
  while (end > start && /\s/.test(source[end - 1])) end--
  return { text: source.slice(start, end), start, end }
}

/**
 * Packs units in order into passages whose rendered text is at most
 * MAX_LENGTH, splitting a unit that is too long on its own at whitespace.
 * `exact` says each unit's text is its source span verbatim, so split pieces
 * get exact spans; otherwise every piece keeps its whole unit's span.
 */
function pack(
  headings: string[],
  units: Unit[],
  exact: boolean,
  render: (parts: Unit[]) => string,
): Passage[] {
  const passages: Passage[] = []
  let parts: Unit[] = []
  const endPassage = () => {
    if (parts.length === 0) return
    const { start } = parts[0]
    const { end } = parts[parts.length - 1]
    passages.push({ headings, text: render(parts), start, end })
    parts = []
  }
  for (const unit of units) {
    for (const piece of splitAtWhitespace(unit, exact)) {
      if (parts.length > 0 && render([...parts, piece]).length > MAX_LENGTH) endPassage()
      parts.push(piece)
    }
  }
  endPassage()
  return passages
}

/** Pieces of a unit's text of at most MAX_LENGTH, cut at whitespace where possible. */
function splitAtWhitespace(unit: Unit, exact: boolean): Unit[] {
  const { text } = unit
  const pieces: Unit[] = []
  let from = 0
  while (text.length - from > MAX_LENGTH) {
    let cut = from + MAX_LENGTH
    while (cut > from && !/\s/.test(text[cut])) cut--
    if (cut === from) {
      // No whitespace to cut at: cut mid-word, but never inside a surrogate pair.
      cut = from + MAX_LENGTH
      const code = text.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut--
    }
    pieces.push(slice(unit, from, cut, exact))
    from = cut
    while (from < text.length && /\s/.test(text[from])) from++
  }
  pieces.push(slice(unit, from, text.length, exact))
  return pieces
}

function slice(unit: Unit, from: number, to: number, exact: boolean): Unit {
  const text = unit.text.slice(from, to).trimEnd()
  if (!exact) return { text, start: unit.start, end: unit.end }
  return { text, start: unit.start + from, end: unit.start + from + text.length }
}
