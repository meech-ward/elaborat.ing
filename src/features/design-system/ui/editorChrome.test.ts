import { describe, expect, test } from "bun:test"
import { commandShortcut, isApplePlatform, viewShortcut } from "./shortcuts"
import { clippedTabs, revealStart, type TabBox } from "./tabOverflow"
import { mandatoryView, viewLabel } from "./views"

// Five tabs, 100 wide with no gaps: a..e at 0, 100, 200, 300, 400.
const tabs: TabBox[] = ["a", "b", "c", "d", "e"].map((value, i) => ({ value, left: i * 100, width: 100 }))

describe("clippedTabs", () => {
  test("nothing is clipped when every tab fits", () => {
    expect(clippedTabs(tabs, 0, 500)).toEqual({ clipped: [], gap: 0 })
  })
  test("tabs past the end are clipped, and +N moves over the empty width", () => {
    expect(clippedTabs(tabs, 0, 250)).toEqual({ clipped: ["c", "d", "e"], gap: 50 })
  })
  test("tabs before a scrolled start are clipped too, in tab order", () => {
    expect(clippedTabs(tabs, 200, 250)).toEqual({ clipped: ["a", "b", "e"], gap: 50 })
  })
  test("tabs that are not laid out clip nothing", () => {
    expect(clippedTabs(tabs.map((tab) => ({ ...tab, left: 0, width: 0 })), 0, 0)).toEqual({ clipped: [], gap: 0 })
  })
  test("a list squeezed to no width clips every tab", () => {
    expect(clippedTabs(tabs, 0, 0)).toEqual({ clipped: ["a", "b", "c", "d", "e"], gap: 0 })
  })
})

describe("revealStart", () => {
  test("a tab already in view keeps the start", () => {
    expect(revealStart(tabs, "b", 0, 250)).toBe(0)
  })
  test("a tab past the end starts the view at a tab edge that shows it whole", () => {
    expect(revealStart(tabs, "d", 0, 250)).toBe(200)
  })
  test("a tab before the start starts the view at that tab", () => {
    expect(revealStart(tabs, "a", 200, 250)).toBe(0)
  })
  test("an unknown tab keeps the start", () => {
    expect(revealStart(tabs, "z", 100, 250)).toBe(100)
  })
})

describe("mandatoryView", () => {
  test("a group change to a known view selects it", () => {
    expect(mandatoryView("split", ["rendered"], ["source", "split", "rendered"])).toBe("rendered")
  })
  test("an empty change (pressing the active view) keeps the current view", () => {
    expect(mandatoryView("split", [], ["source", "split", "rendered"])).toBe("split")
  })
  test("a view the switch does not offer is never selected", () => {
    expect(mandatoryView("source", ["split"], ["source", "rendered"])).toBe("source")
  })
})

describe("viewLabel", () => {
  test("a note's views are Source, Split and Rendered", () => {
    expect((["source", "split", "rendered"] as const).map((view) => viewLabel(view))).toEqual(["Source", "Split", "Rendered"])
  })
  test("a drawing's or diagram's views are Code, Split and Canvas", () => {
    expect((["source", "split", "rendered"] as const).map((view) => viewLabel(view, "canvas"))).toEqual(["Code", "Split", "Canvas"])
  })
})

describe("shortcuts", () => {
  test("Apple platforms use the symbol keys", () => {
    expect(isApplePlatform("MacIntel")).toBe(true)
    expect(isApplePlatform("iPad")).toBe(true)
    expect(viewShortcut(2, true)).toEqual({ label: "⌘⌥2", aria: "Meta+Alt+2" })
    expect(commandShortcut("s", true)).toEqual({ label: "⌘S", aria: "Meta+S" })
  })
  test("other platforms use Ctrl", () => {
    expect(isApplePlatform("Linux x86_64")).toBe(false)
    expect(viewShortcut(3, false)).toEqual({ label: "Ctrl+Alt+3", aria: "Control+Alt+3" })
    expect(commandShortcut(".", false)).toEqual({ label: "Ctrl+.", aria: "Control+." })
  })
})
