import { describe, expect, test } from "bun:test"
import { partialRelay } from "../bridge"
import { cardReducer, INITIAL_CARD_STATE, type CardState } from "../cardState"
import { drawingScanner, noteTail, type SceneElement } from "../live/partial"
import type { CardFile } from "../toolResult"

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
})
