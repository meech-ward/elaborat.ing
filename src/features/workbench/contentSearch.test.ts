import { describe, expect, test } from "bun:test"
import { projectHits, snippet } from "./contentSearch"

describe("projectHits", () => {
  test("keeps this project's files, best first, each once with its best passage", () => {
    const passages = [
      { project_id: "b", path: "other.md", content: "elsewhere" },
      { project_id: "a", path: "notes/plan.md", content: "best" },
      { project_id: "a", path: "flow.d2", content: "second" },
      { project_id: "a", path: "notes/plan.md", content: "worse" },
    ]
    expect(projectHits(passages, "a")).toEqual([
      { path: "notes/plan.md", text: "best" },
      { path: "flow.d2", text: "second" },
    ])
    expect(projectHits(passages, "c")).toEqual([])
  })
})

describe("snippet", () => {
  test("splits out the earliest query word, ignoring case, on one line", () => {
    expect(snippet("# Plan\n\nThe Customer model\nand more", "model customer")).toEqual({ before: "# Plan The ", match: "Customer", after: " model and more" })
  })

  test("trims long text around the match", () => {
    const text = `${"a ".repeat(100)}needle${" b".repeat(100)}`
    const { before, match, after } = snippet(text, "needle", 40)
    expect(match).toBe("needle")
    expect(before.startsWith("…")).toBe(true)
    expect(after.endsWith("…")).toBe(true)
    expect((before + match + after).length).toBeLessThanOrEqual(42)
  })

  test("is the start of the text when no word matches", () => {
    expect(snippet("short text", "absent")).toEqual({ before: "short text", match: "", after: "" })
    expect(snippet("x".repeat(10), "absent", 4)).toEqual({ before: "xxxx…", match: "", after: "" })
  })
})
