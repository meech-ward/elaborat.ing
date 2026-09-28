import { describe, expect, test } from "bun:test"
import { anchorView } from "./anchorView"
import { DRAFT_MARK, noteMarks, notePlaces } from "./noteMarks"
import { sectionAnchor, textAnchor, type CommentAnchor } from "./placement"
import type { RemoteThread } from "./remote"

const NOTE = "# Plan\n\nThe first paragraph says hello.\n\n## Steps\n\nOne step.\n"
const at = (text: string, part: string) => [text.indexOf(part), text.indexOf(part) + part.length] as const

const thread = (id: string, anchor: CommentAnchor, resolved = false): RemoteThread => ({
  id,
  file_id: "aaaaaaaa-0000-4000-8000-00000000000a",
  path: "notes/plan.md",
  file_deleted: false,
  file_version: 1,
  anchor,
  created_at: "2026-09-27T00:00:00Z",
  resolved_at: resolved ? "2026-09-27T01:00:00Z" : null,
  resolved_by: null,
  comments: [],
})

const quote = thread("t-quote", textAnchor(NOTE, ...at(NOTE, "says hello")))
const steps = thread("t-steps", sectionAnchor(NOTE, NOTE.indexOf("## Steps")))
const whole = thread("t-whole", { kind: "document" })
const done = thread("t-done", textAnchor(NOTE, ...at(NOTE, "One step")), true)

describe("note marks", () => {
  test("open threads are marked where their text and heading are now, the open one active", () => {
    const edited = `Added first.\n\n${NOTE}`
    const threads = [quote, steps, whole, done]
    const marks = noteMarks(threads, notePlaces(threads, edited), "t-steps", null)
    expect(marks.map(({ id, kind, active }) => ({ id, kind, active }))).toEqual([
      { id: "t-quote", kind: "text", active: false },
      { id: "t-steps", kind: "section", active: true },
    ])
    expect(edited.slice(marks[0].from, marks[0].to)).toBe("says hello")
    expect(edited.slice(marks[1].from, marks[1].to)).toBe("## Steps")
  })

  test("a thread whose text is deleted detaches: no mark, and the panel shows its quote", () => {
    const edited = NOTE.replace("The first paragraph says hello.", "Something else entirely here.")
    const places = notePlaces([quote], edited)
    expect(places.get("t-quote")).toEqual({ attached: false })
    expect(noteMarks([quote], places, null, null)).toEqual([])
    expect(anchorView(quote.anchor, places.get("t-quote"))).toEqual({ kind: "text", quote: "says hello", detached: true })
  })

  test("a section shows its heading's words, and detaches when the heading becomes prose", () => {
    const places = notePlaces([steps], NOTE.replace("## Steps", "## Steps to take"))
    expect(anchorView(steps.anchor, places.get("t-steps"))).toEqual({ kind: "section", heading: "Steps to take" })
    const prose = notePlaces([steps], NOTE.replace("## Steps", "Steps"))
    expect(anchorView(steps.anchor, prose.get("t-steps"))).toEqual({ kind: "section", heading: "Steps", detached: true })
  })

  test("a new comment's text is marked active while it is written", () => {
    const anchor = textAnchor(NOTE, ...at(NOTE, "One step"))
    const marks = noteMarks([], new Map(), null, { anchor, source: NOTE })
    expect(marks).toEqual([{ id: DRAFT_MARK, kind: "text", from: NOTE.indexOf("One step"), to: NOTE.indexOf("One step") + 8, active: true }])
  })
})
