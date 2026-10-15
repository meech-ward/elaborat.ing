import { describe, expect, test } from "bun:test"
import { partialRelay } from "../bridge"
import { CARD_TEXT, cardReducer, INITIAL_CARD_STATE, type CardState } from "../cardState"
import { commonPrefixLength, drawingScanner, elementChange, noteBeingChanged, noteTail, sameElement, shortFormReader, type SceneElement } from "../live/partial"
import { completeDrawing } from "../../../supabase/functions/mcp-server/tools/drawingCompletion"
import { hasDiagramsToDraw } from "../cardDiagrams"
import type { CardEmbed, CardFile } from "../toolResult"

// The live card: reading a file while the agent writes it, the host's
// partial input at most once a frame, and the card's live phase.

const base = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeWidth: 2, roughness: 1, opacity: 100, seed: 7, groupIds: [], boundElements: null }

const SCENE = {
  type: "excalidraw",
  version: 2,
  // A string value that reads like the key, and an elements key further in: neither is the scene's.
  source: "elements",
  appState: { viewBackgroundColor: "#ffffff", nested: { elements: [{ id: "not-an-element" }] }, gridSize: null },
  elements: [
    { ...base, id: "box", type: "rectangle", x: 0, y: 0, width: 120, height: 60, boundElements: [{ id: "label", type: "text" }] },
    { ...base, id: "label", type: "text", x: 10, y: 18, width: 100, height: 25, text: 'He said "hi" {not json} \\ back\nslash } ] [ é', containerId: "box" },
    { ...base, id: "gone", type: "rectangle", x: 9, y: 9, width: 1, height: 1, isDeleted: true },
    { ...base, id: "link", type: "arrow", x: 120, y: 30, width: 80, height: 0, points: [[0, 0], [80, 0]], endArrowhead: "arrow" },
    { id: "untyped", x: 1 },
    { ...base, id: "note", type: "text", x: 0, y: 100, width: 50, height: 25, text: "}}}\"\"\"" },
  ],
  files: {},
}

/** The scene as a file: pretty-printed, with one letter written as a \u escape. */
const JSON_FILE = JSON.stringify(SCENE, null, 2).replace("é", "\\u00e9")
const MARKDOWN_FILE = [
  "---",
  "excalidraw-plugin: parsed",
  "---",
  "",
  "# Excalidraw Data",
  "",
  "## Text Elements",
  'He said "hi" {not json} ^label',
  "",
  "%%",
  "## Drawing",
  "```json",
  JSON_FILE,
  "```",
  "%%",
  "",
].join("\n")

/** The server's parseDrawing: the elements with a type that are not deleted. */
const EXPECTED = (JSON.parse(JSON_FILE).elements as SceneElement[]).filter((element) => typeof element.type === "string" && element.isDeleted !== true)

describe("reading a drawing as it is written", () => {
  for (const [name, file] of [
    [".excalidraw", JSON_FILE],
    [".excalidraw.md", MARKDOWN_FILE],
  ] as const) {
    test(`every prefix of an ${name} file reads without throwing, the elements only grow, and the end is the whole scene's`, () => {
      const scanner = drawingScanner()
      let count = 0
      for (let end = 0; end <= file.length; end++) {
        const { added, restarted } = scanner.read(file.slice(0, end))
        expect(restarted).toBe(false)
        expect(scanner.elements.length).toBe(count + added.length)
        count = scanner.elements.length
        // What it has read is the scene's elements so far, in order.
        expect(scanner.elements).toEqual(EXPECTED.slice(0, count))
        // Read afresh, the same prefix gives the same elements.
        if (end % 97 === 0) expect(drawingScanner().read(file.slice(0, end)).added).toEqual(EXPECTED.slice(0, count))
      }
      expect(scanner.elements).toEqual(EXPECTED)
    })
  }

  test("content that no longer begins with what was read is read again from the start", () => {
    const scanner = drawingScanner()
    scanner.read(JSON_FILE)
    const changed = JSON_FILE.replace('"box"', '"crate"')
    const { added, restarted } = scanner.read(changed)
    expect(restarted).toBe(true)
    expect(added.map((element) => element.id)).toEqual(["crate", "label", "link", "note"])
  })

  test("a compressed drawing is not read", () => {
    const scanner = drawingScanner()
    expect(scanner.read("---\nexcalidraw-plugin: parsed\n---\n\n%%\n## Drawing\n```compressed-json\nN4Ig").added).toEqual([])
    expect(scanner.compressed).toBe(true)
  })
})

describe("a drawing in draw's short form, completed as it is written", () => {
  // Shapes with a label and no size, and arrows by from and to: one written
  // before the shape it goes to, and one whose shape never comes. A full text,
  // and an old label text that the short form's label replaces.
  const FLOW = JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "browser", type: "rectangle", x: 0, y: 0, label: "Browser" },
        { id: "browser-to-api", type: "arrow", from: "browser", to: "api", label: "fetch" },
        { id: "api", type: "rectangle", x: 300, y: 0, label: "API server" },
        { id: "db", type: "ellipse", x: 600, y: 0, label: "Postgres database", backgroundColor: "#a5d8ff" },
        { id: "db-old-label", type: "text", x: 640, y: 20, text: "DB", containerId: "db" },
        { id: "api-to-db", type: "arrow", from: "api", to: "db" },
        { id: "note", type: "text", x: 0, y: 150, text: 'A full element, "as it is" }' },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
    },
    null,
    2,
  )
  /** The elements by id, leaving out what each lists as bound to it. */
  const byId = (elements: SceneElement[]) => Object.fromEntries(elements.map((element) => [element.id, { ...element, boundElements: null }]))

  test("every prefix completes as the server saves the drawing, each element once, and an arrow once both its shapes have come", () => {
    const saved = JSON.parse(completeDrawing(FLOW)).elements as SceneElement[]
    const scanner = drawingScanner()
    const reader = shortFormReader()
    const drawn: SceneElement[] = []
    // How much of the file had come when each element was drawn.
    const when = new Map<unknown, number>()
    for (let end = 0; end <= FLOW.length; end++) {
      const { added } = scanner.read(FLOW.slice(0, end))
      if (added.length === 0) continue
      for (const element of reader.read(scanner.elements)) {
        drawn.push(element)
        when.set(element.id, end)
      }
    }
    // The same elements, field for field: the same sizes, places and seeds, so
    // the same strokes, but for what a shape lists as bound to it, which is
    // not drawn and fills in as its arrows come.
    expect(drawn.length).toBe(saved.length)
    expect(byId(drawn)).toEqual(byId(saved))
    expect(drawn.map((element) => element.id)).not.toContain("db-old-label")
    // An arrow comes with the second of its shapes, in the file's order, and its label right after it.
    expect(drawn.map((element) => element.id)).toEqual(["browser", "browser-label", "browser-to-api", "browser-to-api-label", "api", "api-label", "db", "db-label", "api-to-db", "note"])
    expect(when.get("browser-to-api")).toBe(when.get("api"))
    expect(when.get("api-to-db")!).toBeGreaterThan(when.get("db")!)
  })

  test("an arrow whose shape never comes is not drawn, and the rest are", () => {
    const scanner = drawingScanner()
    const reader = shortFormReader()
    const lonely = FLOW.replace('"to": "db"', '"to": "cache"')
    scanner.read(lonely)
    const ids = reader.read(scanner.elements).map((element) => element.id)
    expect(ids).toEqual(["browser", "browser-label", "browser-to-api", "browser-to-api-label", "api", "api-label", "db", "db-label", "note"])
    // What it returned, it does not return again.
    expect(reader.read(scanner.elements)).toEqual([])
    // The server refuses the whole drawing.
    expect(() => completeDrawing(lonely)).toThrow('The arrow "api-to-db" goes to "cache", which is not in the drawing.')
  })
})

describe("a note as it is written", () => {
  test("an open frontmatter block and a tag still being written are held back", () => {
    expect(noteTail("-")).toBe("")
    expect(noteTail("---")).toBe("")
    expect(noteTail("---\ntitle: Plan")).toBe("")
    expect(noteTail("---\ntitle: Plan\n--")).toBe("")
    expect(noteTail("---\ntitle: Plan\n---")).toBe("---\ntitle: Plan\n---")
    expect(noteTail("---\ntitle: Plan\n---\n# Plan")).toBe("---\ntitle: Plan\n---\n# Plan")
    expect(noteTail('# Plan\n\n<Drawing src="art/fl')).toBe("# Plan\n\n")
    expect(noteTail("# Plan\n\n<Diagram\n  src=")).toBe("# Plan\n\n")
    expect(noteTail("Text and <")).toBe("Text and ")
    expect(noteTail("<Callout>Hi</")).toBe("<Callout>Hi")
  })

  test("everything else shows as it is", () => {
    for (const text of ["# Plan", "a < b, and 2<3", '<Drawing src="a.excalidraw" />', "Some <b\n\nmore after a blank line", "Not --- frontmatter\n---"]) {
      expect(noteTail(text)).toBe(text)
    }
  })
})

describe("a change to a saved drawing, element by element", () => {
  const box = { ...base, id: "box", type: "rectangle", x: 0, y: 0, width: 120, height: 60, version: 3, versionNonce: 11, updated: 1, index: "a0" }

  test("an element the same apart from Excalidraw's bookkeeping, in any key order, is kept", () => {
    const rewritten = Object.fromEntries(Object.entries({ ...box, version: 9, versionNonce: 42, updated: 7, index: "a5", boundElements: [{ id: "arrow", type: "arrow" }] }).reverse())
    expect(sameElement(box, rewritten)).toBe(true)
    // An agent that leaves the bookkeeping out keeps it too.
    const bare: SceneElement = { ...box }
    for (const key of ["version", "versionNonce", "updated", "index"]) delete bare[key]
    expect(sameElement(box, bare)).toBe(true)
  })

  test("anything that draws differently is a change: a place, a size, a colour, a seed, text, points or a new field", () => {
    for (const change of [{ x: 1 }, { width: 121 }, { strokeColor: "#e03131" }, { seed: 8 }, { roundness: { type: 3 } }, { groupIds: ["g"] }, { link: null }]) {
      expect(sameElement(box, { ...box, ...change })).toBe(false)
    }
    const arrow = { ...base, id: "a", type: "arrow", x: 0, y: 0, points: [[0, 0], [80, 0]] }
    expect(sameElement(arrow, { ...arrow, points: [[0, 0], [80, 10]] })).toBe(false)
    expect(sameElement(arrow, { ...arrow, points: [[0, 0], [80, 0], [90, 0]] })).toBe(false)
    const label = { ...base, id: "t", type: "text", text: "Ship it" }
    expect(sameElement(label, { ...label, text: "Ship it today" })).toBe(false)
    // A field left out is a change too.
    const uncoloured: SceneElement = { ...box }
    delete uncoloured.strokeColor
    expect(sameElement(box, uncoloured)).toBe(false)
  })

  test("each element of the new drawing is kept, changed or new, by its id", () => {
    const saved = new Map<unknown, SceneElement>([["box", box], ["label", { ...base, id: "label", type: "text", text: "Write" }]])
    expect(elementChange(saved, { ...box, version: 4 })).toBe("kept")
    expect(elementChange(saved, { ...base, id: "label", type: "text", text: "Write it" })).toBe("changed")
    expect(elementChange(saved, { ...box, id: "box-2" })).toBe("added")
    expect(elementChange(saved, { ...box, id: undefined })).toBe("added")
    expect(elementChange(new Map(), box)).toBe("added")
  })
})

describe("a change to a saved note", () => {
  const SAVED = "# Launch plan\n\nShip it soon.\n\n## Next\n\nTell the team.\n"

  test("the common start of two texts", () => {
    expect(commonPrefixLength(SAVED, SAVED)).toBe(SAVED.length)
    expect(commonPrefixLength(SAVED, "# Launch")).toBe(8)
    expect(commonPrefixLength(SAVED, "# Launch plan\n\nShip it today")).toBe("# Launch plan\n\nShip it ".length)
    expect(commonPrefixLength(SAVED, "")).toBe(0)
    expect(commonPrefixLength("", SAVED)).toBe(0)
    expect(commonPrefixLength("é", "e")).toBe(0)
  })

  test("the saved note shows at once while the new text is still its start; from where it differs, the new text is written in", () => {
    for (const written of ["", "# Launch", SAVED.slice(0, 30), SAVED]) {
      expect(noteBeingChanged(SAVED, written)).toEqual({ text: SAVED, writing: false })
    }
    const today = "# Launch plan\n\nShip it today"
    expect(noteBeingChanged(SAVED, today)).toEqual({ text: today, writing: true })
    // A new paragraph at the end comes in after the whole saved note.
    const added = `${SAVED}\nAnd a new paragraph`
    expect(noteBeingChanged(SAVED, added)).toEqual({ text: added, writing: true })
  })

  test("once the whole input is in, the new text shows, also where it only cuts the saved note short", () => {
    const shorter = "# Launch plan\n\nShip it soon.\n"
    expect(noteBeingChanged(SAVED, shorter)).toEqual({ text: SAVED, writing: false })
    expect(noteBeingChanged(SAVED, shorter, true)).toEqual({ text: shorter, writing: true })
    expect(noteBeingChanged(SAVED, SAVED, true)).toEqual({ text: SAVED, writing: true })
  })
})

describe("the host's partial input", () => {
  test("only the latest in a frame is passed on, and none once the input has come", () => {
    const frames: Array<() => void> = []
    const passed: unknown[] = []
    const relay = partialRelay(
      (args) => passed.push(args),
      (run) => frames.push(run),
    )
    relay.partial({ content: "a" })
    relay.partial({ content: "ab" })
    relay.partial({ content: "abc" })
    expect(frames.length).toBe(1)
    frames.shift()!()
    expect(passed).toEqual([{ content: "abc" }])
    relay.partial({ content: "abcd" })
    relay.close()
    frames.shift()!()
    relay.partial({ content: "abcde" })
    expect(frames).toEqual([])
    expect(passed).toEqual([{ content: "abc" }])
  })
})

describe("the card's live phase", () => {
  const file = { path: "art/flow.excalidraw", kind: "drawing" } as CardFile
  const live: CardState = { phase: "live", path: "art/flow.excalidraw", kind: "drawing" }

  test("loading goes live, stays live through the input, and shows the saved file", () => {
    let state = cardReducer(INITIAL_CARD_STATE, { type: "live", path: "art/flow.excalidraw", kind: "drawing" })
    expect(state).toEqual(live)
    state = cardReducer(state, { type: "input", path: "art/flow.excalidraw" })
    expect(state).toEqual(live)
    state = cardReducer(state, { type: "result", file })
    expect(state.phase === "shown" && state.file).toBe(file)
  })

  test("a card that shows a file or a problem does not go live", () => {
    const shown = cardReducer(INITIAL_CARD_STATE, { type: "result", file })
    expect(cardReducer(shown, { type: "live", path: "x.md", kind: "note" })).toBe(shown)
    const problem = cardReducer(INITIAL_CARD_STATE, { type: "problem", message: "No.", tone: "danger" })
    expect(cardReducer(problem, { type: "live", path: "x.md", kind: "note" })).toBe(problem)
  })

  test("a failed save or a cancel ends it with the problem", () => {
    expect(cardReducer(live, { type: "problem", message: "A file already exists.", tone: "danger" })).toEqual({ phase: "problem", message: "A file already exists.", tone: "danger" })
  })

  test("once written, a file whose diagrams the card lays out says so in its footer until the saved file shows", () => {
    const footer = (state: CardState) => (state.phase === "live" ? CARD_TEXT.live(state) : null)
    expect(footer(live)).toBe("Drawing art/flow.excalidraw")
    const diagram = cardReducer(INITIAL_CARD_STATE, { type: "live", path: "flows/sign-in.d2", kind: "diagram" })
    expect(footer(diagram)).toBe("Writing flows/sign-in.d2")
    const layingOut = cardReducer(diagram, { type: "laying-out" })
    expect(footer(layingOut)).toBe("Laying out flows/sign-in.d2")
    expect(cardReducer(layingOut, { type: "result", file })).toMatchObject({ phase: "shown", file })
    // Only a live card says it.
    const shown = cardReducer(INITIAL_CARD_STATE, { type: "result", file })
    expect(cardReducer(shown, { type: "laying-out" })).toBe(shown)
  })

  test("only a file with a diagram the card draws itself is laid out once written", () => {
    const embed = (status: CardEmbed["status"]): CardEmbed => ({ kind: "diagram", path: "flows/sign-in.d2", url: null, status })
    const sent = { "flows/sign-in.d2": { source: "a -> b" } }
    const note = { path: "notes/plan.md", kind: "note", embeds: [], svgs: {}, diagrams: {} } as unknown as CardFile
    expect(hasDiagramsToDraw(note)).toBe(false)
    expect(hasDiagramsToDraw({ ...note, embeds: [embed("drawn")], svgs: { "flows/sign-in.d2": "<svg></svg>" } })).toBe(false)
    expect(hasDiagramsToDraw({ ...note, embeds: [embed("not_drawn")], diagrams: sent })).toBe(true)
  })
})
