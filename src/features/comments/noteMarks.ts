import type { TextRange } from "./anchoring"
import type { ThreadPlace } from "./controller"
import { placeTextAnchor, type CommentAnchor } from "./placement"
import type { RemoteThread } from "./remote"

// Where a note's threads are in the text on screen, and what the note's
// views mark: the commented text of each open, attached thread, and of a new
// comment while it is being written. Pure: the views and the panel share it.

/** The id a new comment's text is marked with while it is being written. */
export const DRAFT_MARK = "draft"

/** Commented text in a note's source, as the source and rendered views mark it. */
export type CommentMark = {
  /** The thread's id, or DRAFT_MARK. */
  id: string
  /** A selection, or a heading line (a section). */
  kind: "text" | "section"
  /** Where it is in the source now (UTF-16 offsets). */
  from: number
  to: number
  /** The thread open in the panel, or the new comment: marked more strongly. */
  active: boolean
}

/** Where an anchor is in a note's `source` now. Element anchors never attach to a note. */
export function notePlace(anchor: CommentAnchor, source: string): ThreadPlace {
  if (anchor.kind === "document") return { attached: true }
  if (anchor.kind === "element") return { attached: false }
  const placement = placeTextAnchor(source, anchor)
  if (placement.status === "detached" || !placement.range) return { attached: false }
  let range: TextRange = placement.range
  if (anchor.kind === "section") {
    // A section is its whole heading line now, even when the heading grew.
    const newline = source.indexOf("\n", range.start)
    const end = newline === -1 ? source.length : newline
    range = { start: range.start, end: source[end - 1] === "\r" ? end - 1 : end }
  }
  return { attached: true, range, text: source.slice(range.start, range.end) }
}

/** Every thread's place in `source`, by thread id. */
export function notePlaces(threads: readonly RemoteThread[], source: string): Map<string, ThreadPlace> {
  return new Map(threads.map((thread) => [thread.id, notePlace(thread.anchor, source)]))
}

/**
 * The marks for a note: each open thread whose text or heading is still
 * there, and the new comment's anchor if it has one here. Ordered by where
 * they start.
 */
export function noteMarks(
  threads: readonly RemoteThread[],
  places: ReadonlyMap<string, ThreadPlace>,
  activeThreadId: string | null,
  draft: { anchor: CommentAnchor; source: string } | null,
): CommentMark[] {
  const marks: CommentMark[] = []
  for (const thread of threads) {
    const place = places.get(thread.id)
    if (thread.resolved_at !== null || !place?.range || (thread.anchor.kind !== "text" && thread.anchor.kind !== "section")) continue
    marks.push({ id: thread.id, kind: thread.anchor.kind, from: place.range.start, to: place.range.end, active: thread.id === activeThreadId })
  }
  if (draft && (draft.anchor.kind === "text" || draft.anchor.kind === "section")) {
    const place = notePlace(draft.anchor, draft.source)
    if (place.range) marks.push({ id: DRAFT_MARK, kind: draft.anchor.kind, from: place.range.start, to: place.range.end, active: true })
  }
  return marks.sort((a, b) => a.from - b.from || a.to - b.to)
}
