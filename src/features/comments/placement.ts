// Comment anchors, as the database stores them (supabase/schemas/comments.sql),
// and where each one is in a file now. An anchor is described once, against
// the text the person was looking at, and never rewritten: every reader finds
// it again in the text it shows. One that can no longer be found is detached.
//
// This module is pure. A copy lives in supabase/functions/_shared/comments/
// for the MCP server; sharedCopies.test.ts fails when the two drift apart.

import { anchorRange, describeRange } from "./anchoring"
import type { TextPositionSelector, TextQuoteSelector, TextRange } from "./anchoring"

/** The longest text a text or section anchor quotes, in UTF-16 code units. */
export const MAX_QUOTE_LENGTH = 5000

/** The longest label an element anchor keeps. */
export const MAX_LABEL_LENGTH = 200

/** A selection in a file's source, or a note's heading line (`section`). */
export type TextAnchor = { kind: "text" | "section"; quote: TextQuoteSelector; position: TextPositionSelector }

/**
 * An element of a drawing, by its Excalidraw id. `label` is shown when the
 * element is gone. `point` marks a spot on it, as fractions of its width and
 * height from the top-left of its unrotated box.
 */
export type ElementAnchor = { kind: "element"; element_id: string; label: string; point?: { x: number; y: number } }

export type CommentAnchor = { kind: "document" } | TextAnchor | ElementAnchor

export type Placement = { status: "attached"; range?: TextRange } | { status: "detached" }

/** A text anchor for source[start, end). RangeError when empty, out of bounds or longer than MAX_QUOTE_LENGTH. */
export function textAnchor(source: string, start: number, end: number): TextAnchor {
  if (end - start > MAX_QUOTE_LENGTH) {
    throw new RangeError(`A comment can quote at most ${MAX_QUOTE_LENGTH} characters`)
  }
  const [quote, position] = describeRange(source, start, end)
  return { kind: "text", quote, position }
}

/** A section anchor for the heading line holding `offset`. RangeError when that line is not a heading. */
export function sectionAnchor(source: string, offset: number): TextAnchor {
  const line = lineAt(source, offset)
  if (!line || !isHeadingLine(source, offset)) {
    throw new RangeError(`There is no heading at offset ${offset}`)
  }
  if (line.end - line.start > MAX_QUOTE_LENGTH) {
    throw new RangeError(`A comment can quote at most ${MAX_QUOTE_LENGTH} characters`)
  }
  const [quote, position] = describeRange(source, line.start, line.end)
  return { kind: "section", quote, position }
}

/**
 * Whether the line holding `offset` is an ATX heading line (`## Setup`), or
 * the text line of a setext heading (the line above its `===` or `---`).
 * Lines in fenced code and in frontmatter are never headings.
 */
export function isHeadingLine(source: string, offset: number): boolean {
  const target = lineAt(source, offset)
  if (!target) return false
  const all = splitLines(source)
  const index = all.findIndex((line) => line.start === target.start)
  return headingLineIndexes(all).has(index)
}

/**
 * Where a text or section anchor is in `source` now. A section must still
 * start a heading line, so a heading turned into prose never latches onto
 * nearby text or onto a longer heading that contains it.
 */
export function placeTextAnchor(source: string, anchor: TextAnchor): Placement {
  const range = anchorRange(source, anchor.quote, anchor.position)
  if (range === null) return { status: "detached" }
  if (anchor.kind === "section" && !startsHeadingLine(source, range.start)) return { status: "detached" }
  return { status: "attached", range }
}

/** Whether an element anchor's element is still in the drawing. */
export function placeElementAnchor(liveElementIds: ReadonlySet<string>, anchor: ElementAnchor): Placement {
  return liveElementIds.has(anchor.element_id) ? { status: "attached" } : { status: "detached" }
}

/**
 * Where any anchor is now. A document anchor is always attached. A text or
 * section anchor needs the file's source, an element anchor the ids of the
 * drawing's live elements; without them it is detached.
 */
export function placeAnchor(
  anchor: CommentAnchor,
  file: { source?: string; liveElementIds?: ReadonlySet<string> },
): Placement {
  switch (anchor.kind) {
    case "document":
      return { status: "attached" }
    case "element":
      return file.liveElementIds ? placeElementAnchor(file.liveElementIds, anchor) : { status: "detached" }
    default:
      return file.source === undefined ? { status: "detached" } : placeTextAnchor(file.source, anchor)
  }
}

/** The parts of an Excalidraw element a label reads. */
export type LabelElement = {
  id?: unknown
  type?: unknown
  text?: unknown
  originalText?: unknown
  containerId?: unknown
  isDeleted?: unknown
}

/**
 * The label an element anchor keeps: the element's text, or the text bound to
 * it (a text element whose `containerId` is the element), or else its type,
 * with runs of whitespace as one space and cut to MAX_LABEL_LENGTH. Null when
 * the element is not live in `elements`.
 */
export function elementLabel(elements: readonly LabelElement[], elementId: string): string | null {
  const live = elements.filter((element) => element.isDeleted !== true)
  const element = live.find((candidate) => candidate.id === elementId)
  if (!element) return null
  const textOf = (candidate: LabelElement) => {
    const raw =
      typeof candidate.originalText === "string" && candidate.originalText.trim()
        ? candidate.originalText
        : typeof candidate.text === "string"
          ? candidate.text
          : ""
    return raw.replace(/\s+/g, " ").trim()
  }
  let label = element.type === "text" ? textOf(element) : ""
  if (!label) {
    const bound = live.find((candidate) => candidate.type === "text" && candidate.containerId === elementId)
    if (bound) label = textOf(bound)
  }
  if (!label) label = typeof element.type === "string" ? element.type : "element"
  return cut(label, MAX_LABEL_LENGTH)
}

/** `text` cut to at most `length` code units, never inside a surrogate pair. */
function cut(text: string, length: number): string {
  if (text.length <= length) return text
  const code = text.charCodeAt(length - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length)
}

/** Whether `offset` starts a heading line: at the start of the line, after any indentation. */
function startsHeadingLine(source: string, offset: number): boolean {
  const line = lineAt(source, offset)
  return line !== null && /^[ \t]*$/.test(source.slice(line.start, offset)) && isHeadingLine(source, offset)
}

type Line = { start: number; end: number; text: string }

/** Every line of `source`, with its start and its end before the line break. */
function splitLines(source: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const newline = source.indexOf("\n", start)
    const next = newline === -1 ? source.length : newline
    const end = next > start && source[next - 1] === "\r" ? next - 1 : next
    lines.push({ start, end, text: source.slice(start, end) })
    if (newline === -1) return lines
    start = newline + 1
  }
}

/** The line holding `offset`, or null when it is out of bounds. */
function lineAt(source: string, offset: number): Line | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return null
  const start = source.lastIndexOf("\n", offset - 1) + 1
  const newline = source.indexOf("\n", offset)
  const next = newline === -1 ? source.length : newline
  const end = next > start && source[next - 1] === "\r" ? next - 1 : next
  return { start, end, text: source.slice(start, end) }
}

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** Lines that cannot be a setext heading's text: blank, indented code, list items, quotes, fences, ATX headings and breaks. */
const NOT_PARAGRAPH = /^(?:[ \t]*$| {4}|\t| {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}>| {0,3}(?:`{3}|~{3})| {0,3}#{1,6}(?:[ \t]|$)| {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$)/

/** The indexes of the heading lines, skipping frontmatter and fenced code. */
function headingLineIndexes(lines: Line[]): Set<number> {
  const headings = new Set<number>()
  let index = 0
  // Frontmatter: `---` (YAML) or `+++` (TOML) on the first line, to the same again.
  const opening = lines[0]?.text.trimEnd()
  if (opening === "---" || opening === "+++") {
    const close = lines.findIndex((line, i) => i > 0 && line.text.trimEnd() === opening)
    if (close !== -1) index = close + 1
  }
  let fence: string | null = null
  for (; index < lines.length; index++) {
    const { text } = lines[index]
    const marker = FENCE.exec(text)?.[1]
    if (fence !== null) {
      // A closing fence: the same character, at least as long, and nothing after it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (ATX_HEADING.test(text)) {
      headings.add(index)
    } else if (
      index + 1 < lines.length &&
      SETEXT_UNDERLINE.test(lines[index + 1].text) &&
      !NOT_PARAGRAPH.test(text)
    ) {
      headings.add(index)
      index++ // the underline
    }
  }
  return headings
}
