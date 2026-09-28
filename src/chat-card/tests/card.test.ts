import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { cardReducer, INITIAL_CARD_STATE, type CardState } from "../cardState"
import { parseShowResult, parseWriteResult, type CardFile } from "../toolResult"

const URL = "https://elaborat.ing/projects/p/notes/plan.md"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'

const result = (view: Record<string, unknown>, meta?: Record<string, unknown>) => ({
  content: [{ type: "text", text: "Showing" }],
  structuredContent: { project_id: "p", path: "notes/plan.md", kind: "note", version: 4, url: URL, truncated: false, embeds: [], ...view },
  ...(meta ? { _meta: meta } : {}),
})

describe("show_file's result", () => {
  test("a note keeps its HTML, source and drawn SVG; links and drawings count only from the app and the server", () => {
    const shown = parseShowResult(
      result(
        {
          url: "https://example.com/x",
          embeds: [
            { kind: "drawing", path: "a.excalidraw", url: "https://elaborat.ing/projects/p/a.excalidraw", status: "drawn" },
            { kind: "diagram", path: "b.d2", url: "javascript:alert(1)", status: "stale" },
            { path: 3 },
          ],
        },
        { "elaborat.ing/html": "<h1>Plan</h1>", "elaborat.ing/source": "# Plan\n", "elaborat.ing/svg": { "a.excalidraw": SVG, "b.d2": "<script>" } },
      ),
    )
    expect(shown.ok).toBe(true)
    if (!shown.ok) return
    expect(shown.file.url).toBeNull()
    expect(shown.file.html).toBe("<h1>Plan</h1>")
    expect(shown.file.source).toBe("# Plan\n")
    expect(shown.file.svgs).toEqual({ "a.excalidraw": SVG })
    expect(shown.file.embeds).toEqual([
      { kind: "drawing", path: "a.excalidraw", url: "https://elaborat.ing/projects/p/a.excalidraw", status: "drawn" },
      { kind: "diagram", path: "b.d2", url: null, status: "stale" },
      null,
    ])
  })

  test("a cut note is not edited here, and ChatGPT's metadata stands in for a missing _meta", () => {
    const shown = parseShowResult(result({ truncated: true }), { "elaborat.ing/html": "<p>Start</p>", "elaborat.ing/source": "Start" })
    expect(shown.ok && [shown.file.html, shown.file.source, shown.file.url]).toEqual(["<p>Start</p>", null, URL])
  })

  test("an error or an unreadable result is a problem with the server's words", () => {
    expect(parseShowResult({ isError: true, content: [{ type: "text", text: "No file at x." }], structuredContent: {} })).toEqual({ ok: false, message: "No file at x." })
    expect(parseShowResult({ structuredContent: { path: 3 } })).toEqual({ ok: false, message: "Something went wrong." })
  })
})

describe("write_file's result", () => {
  test("saved with the note's new version, a conflict, or a failure with its message", () => {
    const saved = { structuredContent: { status: "saved", changes: [{ op: "put", path: "other.md", version: 9 }, { op: "put", path: "notes/plan.md", version: 5 }] } }
    expect(parseWriteResult(saved, "notes/plan.md")).toEqual({ kind: "saved", version: 5 })
    expect(parseWriteResult({ structuredContent: { status: "conflict", conflicts: [] } }, "notes/plan.md")).toEqual({ kind: "conflict" })
    expect(parseWriteResult({ isError: true, content: [{ type: "text", text: "Not allowed." }] }, "notes/plan.md")).toEqual({ kind: "failed", message: "Not allowed." })
    expect(parseWriteResult(undefined, "notes/plan.md")).toEqual({ kind: "failed", message: "Saving failed." })
  })
})

describe("the card's state", () => {
  const shown = parseShowResult(result({}, { "elaborat.ing/html": "<p>x</p>", "elaborat.ing/source": "x" }))
  const file = (shown.ok ? shown.file : null) as CardFile
  const run = (...events: Parameters<typeof cardReducer>[1][]) => events.reduce<CardState>(cardReducer, INITIAL_CARD_STATE)

  test("the host's results are held off while the note is edited, and a reload after a save is not", () => {
    const editing = run({ type: "result", file }, { type: "start-edit" }, { type: "editor-ready" })
    expect(cardReducer(editing, { type: "result", file: { ...file, version: 9 } })).toBe(editing)
    expect(cardReducer(editing, { type: "problem", message: "x", tone: "info" })).toBe(editing)
    const reloaded = cardReducer(editing, { type: "reloaded", file: { ...file, version: 5 }, version: 5 })
    expect(reloaded).toMatchObject({ phase: "shown", mode: "read", status: { kind: "saved", version: 5 } })
  })

  test("a failed save keeps Save on with the reason; saved but not reloaded keeps editing from the saved text", () => {
    const failed = run({ type: "result", file }, { type: "start-edit" }, { type: "editor-ready" }, { type: "saving" }, { type: "save-failed", message: "offline" })
    expect(failed).toMatchObject({ mode: "edit", busy: false, dirty: true, banner: { tone: "danger", text: "Not saved: offline" } })
    const kept = cardReducer(failed, { type: "saved-not-reloaded", source: "y", version: 5 })
    expect(kept).toMatchObject({ mode: "edit", dirty: false, status: { kind: "saved", version: 5 }, file: { source: "y", version: 5 } })
  })
})

test("the card's words have no em dashes", () => {
  for (const name of ["CardView.tsx", "ChatCard.tsx", "cardState.ts", "toolResult.ts"]) {
    expect(readFileSync(new globalThis.URL(`../${name}`, import.meta.url), "utf8")).not.toContain("—")
  }
})
