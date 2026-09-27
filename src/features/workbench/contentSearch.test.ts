import { describe, expect, test } from "bun:test"
import { plainText, projectHits, snippet } from "./contentSearch"

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
    expect(snippet("# Plan\n\nThe Customer model\nand more", "model customer")).toEqual({ before: "Plan The ", match: "Customer", after: " model and more" })
  })

  test("trims long text around the match", () => {
    const text = `${"a ".repeat(100)}needle${" b".repeat(100)}`
    const { before, match, after } = snippet(text, "needle", 40)
    expect(match).toBe("needle")
    expect(before.startsWith("…")).toBe(true)
    expect(after.endsWith("…")).toBe(true)
    expect((before + match + after).length).toBeLessThanOrEqual(42)
  })

  test("shows Markdown as plain text", () => {
    expect(snippet("Our **customers** and `orders`", "customers")).toEqual({ before: "Our ", match: "customers", after: " and orders" })
  })

  test("is the start of the text when no word matches", () => {
    expect(snippet("short text", "absent")).toEqual({ before: "short text", match: "", after: "" })
    expect(snippet("x".repeat(10), "absent", 4)).toEqual({ before: "xxxx…", match: "", after: "" })
  })
})

describe("plainText", () => {
  test("drops Markdown and MDX marks and keeps the words", () => {
    const markdown = [
      "## The *plan*",
      "> A __quote__ with ~~old~~ text",
      "- [x] Done, see [the docs](https://example.com) and ![a chart](chart.png)",
      "1. Call `save()` first",
      "<Callout type=\"note\">Careful</Callout>",
      "| name | role |",
      "| --- | :-: |",
      "| Ada | owner |",
      "```ts",
      "const snake_case_name = 2 * 3 * 4",
      "```",
      "---",
    ].join("\n")
    expect(plainText(markdown).replace(/\s+/g, " ").trim()).toBe(
      "The plan A quote with old text Done, see the docs and a chart Call save() first Careful name role Ada owner const snake_case_name = 2 * 3 * 4",
    )
  })
})
