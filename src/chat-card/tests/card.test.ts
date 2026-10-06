import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { CARD_SCRIPT } from "../../../supabase/functions/mcp-server/tools/cardEditorScript"
import { cardReducer, INITIAL_CARD_STATE, type CardState } from "../cardState"
import { modulesAllowed } from "../modules"
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

  test("a note from a shared project says so; anything unreadable counts as shared, and a missing flag as the person's own", () => {
    const shared = (value?: unknown) => {
      const shown = parseShowResult(result(value === undefined ? {} : { shared: value }))
      return shown.ok && shown.file.shared
    }
    expect([shared(true), shared(false), shared("yes"), shared()]).toEqual([true, false, true, false])
  })

  test("who last changed a shared note's component files comes with them; unreadable names are left out, not the files", () => {
    const withEditors = (editors: unknown) => {
      const shown = parseShowResult(
        result({ path: "notes/plan.mdx", shared: true }, { "elaborat.ing/source": "# Plan\n", "elaborat.ing/components": { modules: { "ui/card.mdx": "x" }, editors } }),
      )
      return shown.ok ? [shown.file.components, shown.file.editors] : null
    }
    expect(withEditors({ "ui/card.mdx": "Ana" })).toEqual([{ "ui/card.mdx": "x" }, { "ui/card.mdx": "Ana" }])
    expect(withEditors({ "ui/card.mdx": 3 })).toEqual([{ "ui/card.mdx": "x" }, {}])
    expect(withEditors(undefined)).toEqual([{ "ui/card.mdx": "x" }, {}])
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

describe("the modules the card loads from elaborat.ing", () => {
  const modules = new globalThis.URL("../../../public/chat-card/", import.meta.url)
  const addresses = [...new Set([...CARD_SCRIPT.matchAll(/["'`]https:\/\/elaborat\.ing\/chat-card\/([\w.-]+)["'`]/g)].map((match) => match[1]))]

  test("every file the view names is committed, with every file it imports, in the current build", () => {
    const builds = JSON.parse(readFileSync(new globalThis.URL("builds.json", modules), "utf8")) as { current: string[] }
    // The editor, the live view, the compiler, the frame's runtime and stylesheet, and three fonts.
    expect(addresses.length).toBe(8)
    const seen = new Set<string>()
    const visit = (name: string) => {
      if (seen.has(name)) return
      seen.add(name)
      expect(existsSync(new globalThis.URL(name, modules)), name).toBe(true)
      if (!name.endsWith(".js")) return
      const code = readFileSync(new globalThis.URL(name, modules), "utf8")
      for (const [, next] of code.matchAll(/(?:from|import)\s*\(?\s*["'`]\.\/([\w.-]+)["'`]/g)) visit(next)
    }
    for (const name of addresses) visit(name)
    expect([...seen].filter((name) => !builds.current.includes(name))).toEqual([])
    // The charts' library is one of them: a module the frame imports only for a note with a chart.
    expect([...seen].some((name) => name.startsWith("documentCharts-"))).toBe(true)
  })

  test("the site serves them to any origin, including the preview frame's opaque one", () => {
    const headers = readFileSync(new globalThis.URL("../../../public/_headers", import.meta.url), "utf8")
    expect(headers).toMatch(/^\/chat-card\/\*\n {2}Access-Control-Allow-Origin: \*$/m)
  })

  test("the card knows the host allows them only when it says so", () => {
    Object.assign(globalThis, { CARD_MODULES: { editor: "", compile: "", frame: "https://elaborat.ing/chat-card/frame.js", frameStyle: "" } })
    expect(modulesAllowed(null)).toBeNull()
    expect(modulesAllowed([])).toBe(false)
    expect(modulesAllowed(["https://example.com", "not a url"])).toBe(false)
    expect(modulesAllowed(["https://elaborat.ing"])).toBe(true)
    expect(modulesAllowed(["https://elaborat.ing/"])).toBe(true)
  })
})
