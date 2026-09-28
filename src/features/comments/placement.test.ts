import { describe, expect, test } from "bun:test"
import {
  elementLabel,
  isHeadingLine,
  MAX_QUOTE_LENGTH,
  placeAnchor,
  placeElementAnchor,
  placeTextAnchor,
  sectionAnchor,
  textAnchor,
  type ElementAnchor,
} from "./placement"

const note = ["# Guide", "", "Intro text for everyone.", "", "## Setup", "", "Install the tools first, then run them.", ""].join("\n")

/** The range of the first occurrence of `text` in `source`. */
function rangeOf(source: string, text: string) {
  const start = source.indexOf(text)
  if (start === -1) throw new Error(`not in source: ${text}`)
  return { start, end: start + text.length }
}

describe("textAnchor", () => {
  test("describes the range with the anchoring selectors", () => {
    const { start, end } = rangeOf(note, "Install the tools")
    expect(textAnchor(note, start, end)).toEqual({
      kind: "text",
      quote: {
        type: "TextQuoteSelector",
        exact: "Install the tools",
        prefix: "o text for everyone.\n\n## Setup\n\n",
        suffix: " first, then run them.\n",
      },
      position: { type: "TextPositionSelector", start, end },
    })
  })

  test("refuses empty and over-long ranges", () => {
    expect(() => textAnchor(note, 3, 3)).toThrow(RangeError)
    const long = "x".repeat(MAX_QUOTE_LENGTH + 1)
    expect(() => textAnchor(long, 0, long.length)).toThrow(RangeError)
    expect(textAnchor(long, 0, MAX_QUOTE_LENGTH).quote.exact).toHaveLength(MAX_QUOTE_LENGTH)
  })
})

describe("text anchors after edits", () => {
  const { start, end } = rangeOf(note, "Install the tools first")
  const anchor = textAnchor(note, start, end)

  test("stay attached through an insert before them", () => {
    const edited = note.replace("Intro text", "A much longer intro text")
    expect(placeTextAnchor(edited, anchor)).toEqual({ status: "attached", range: rangeOf(edited, "Install the tools first") })
  })

  test("stay attached through an insert inside them", () => {
    const edited = note.replace("the tools first", "the new tools first")
    expect(placeTextAnchor(edited, anchor)).toEqual({ status: "attached", range: rangeOf(edited, "Install the new tools first") })
  })

  test("detach when their text is deleted", () => {
    const edited = note.replace("Install the tools first, then run them.", "Nothing to do here at all.")
    expect(placeTextAnchor(edited, anchor)).toEqual({ status: "detached" })
  })
})

describe("section anchors", () => {
  const setup = rangeOf(note, "## Setup")
  const anchor = sectionAnchor(note, setup.start + 3)

  test("quote the whole heading line", () => {
    expect(anchor.kind).toBe("section")
    expect(anchor.quote.exact).toBe("## Setup")
    expect(anchor.position).toEqual({ type: "TextPositionSelector", ...setup })
  })

  test("follow a heading that moved", () => {
    const moved = ["## Setup", "", "Install the tools first, then run them.", "", "# Guide", "", "Intro text for everyone.", ""].join("\n")
    expect(placeTextAnchor(moved, anchor)).toEqual({ status: "attached", range: rangeOf(moved, "## Setup") })
  })

  test("follow a renamed heading", () => {
    const renamed = note.replace("## Setup", "## Set it up")
    const placement = placeTextAnchor(renamed, anchor)
    expect(placement.status).toBe("attached")
    if (placement.status === "attached") expect(placement.range?.start).toBe(renamed.indexOf("## Set it up"))
  })

  test("detach when the heading line is deleted", () => {
    expect(placeTextAnchor(note.replace("## Setup\n\n", ""), anchor)).toEqual({ status: "detached" })
  })

  test("detach when the heading becomes prose", () => {
    expect(placeTextAnchor(note.replace("## Setup", "Setup"), anchor)).toEqual({ status: "detached" })
  })

  test("never latch onto a longer heading that contains them", () => {
    const nested = note.replace("## Setup", "Setup") + "\n### Setup\n"
    expect(placeTextAnchor(nested, anchor)).toEqual({ status: "detached" })
  })

  test("work for setext headings, on the text line", () => {
    const setext = "Guide\n=====\n\nIntro.\n\nSetup\n-----\n\nSteps.\n"
    const section = sectionAnchor(setext, setext.indexOf("Setup"))
    expect(section.quote.exact).toBe("Setup")
    expect(placeTextAnchor(setext.replace("Intro.", "A longer intro."), section).status).toBe("attached")
    expect(placeTextAnchor(setext.replace("Setup\n-----", "Setup"), section)).toEqual({ status: "detached" })
  })

  test("sectionAnchor refuses a line that is not a heading", () => {
    expect(() => sectionAnchor(note, note.indexOf("Intro"))).toThrow(RangeError)
    expect(() => sectionAnchor(note, note.length + 1)).toThrow(RangeError)
  })
})

describe("isHeadingLine", () => {
  test("finds ATX and setext headings", () => {
    const source = "# One\ntext\n\nTwo\n===\n   ### Three ###\n#hashtag\n"
    expect(isHeadingLine(source, 0)).toBe(true)
    expect(isHeadingLine(source, source.indexOf("text"))).toBe(false)
    expect(isHeadingLine(source, source.indexOf("Two"))).toBe(true)
    expect(isHeadingLine(source, source.indexOf("==="))).toBe(false)
    expect(isHeadingLine(source, source.indexOf("### Three"))).toBe(true)
    expect(isHeadingLine(source, source.indexOf("#hashtag"))).toBe(false)
  })

  test("skips fenced code, frontmatter, lists and thematic breaks", () => {
    const source = ["---", "title: Plan", "---", "", "```sh", "# not a heading", "```", "", "- item", "---", "", "***", "---", ""].join("\n")
    expect(isHeadingLine(source, source.indexOf("title"))).toBe(false)
    expect(isHeadingLine(source, source.indexOf("# not"))).toBe(false)
    expect(isHeadingLine(source, source.indexOf("- item"))).toBe(false)
    expect(isHeadingLine(source, source.indexOf("***"))).toBe(false)
  })
})

describe("element anchors", () => {
  const anchor: ElementAnchor = { kind: "element", element_id: "box", label: "Start", point: { x: 0.5, y: 0.5 } }

  test("are attached while the element is live, and detached once it is gone", () => {
    expect(placeElementAnchor(new Set(["box", "arrow"]), anchor)).toEqual({ status: "attached" })
    expect(placeElementAnchor(new Set(["arrow"]), anchor)).toEqual({ status: "detached" })
  })

  test("take their label from the element's text, its bound text, or its type", () => {
    const elements = [
      { id: "box", type: "rectangle" },
      { id: "label", type: "text", text: "Start\nhere", originalText: "Start here", containerId: "box" },
      { id: "note", type: "text", text: "  A   note " },
      { id: "plain", type: "ellipse" },
      { id: "gone", type: "diamond", isDeleted: true },
    ]
    expect(elementLabel(elements, "box")).toBe("Start here")
    expect(elementLabel(elements, "note")).toBe("A note")
    expect(elementLabel(elements, "plain")).toBe("ellipse")
    expect(elementLabel(elements, "gone")).toBeNull()
    expect(elementLabel(elements, "missing")).toBeNull()
  })

  test("cut long labels to 200 characters, never inside a surrogate pair", () => {
    expect(elementLabel([{ id: "t", type: "text", text: "x".repeat(300) }], "t")).toHaveLength(200)
    const emoji = elementLabel([{ id: "t", type: "text", text: `${"x".repeat(199)}😀` }], "t")
    expect(emoji).toBe("x".repeat(199))
  })
})

describe("placeAnchor", () => {
  test("document anchors are always attached", () => {
    expect(placeAnchor({ kind: "document" }, {})).toEqual({ status: "attached" })
  })

  test("places text and element anchors against what it is given", () => {
    const text = textAnchor(note, 0, 7)
    expect(placeAnchor(text, { source: note })).toEqual({ status: "attached", range: { start: 0, end: 7 } })
    expect(placeAnchor(text, {})).toEqual({ status: "detached" })
    const element: ElementAnchor = { kind: "element", element_id: "box", label: "rectangle" }
    expect(placeAnchor(element, { liveElementIds: new Set(["box"]) })).toEqual({ status: "attached" })
    expect(placeAnchor(element, { source: note })).toEqual({ status: "detached" })
  })
})
