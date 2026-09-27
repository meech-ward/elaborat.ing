import { describe, expect, test } from "bun:test"
import { labelParts, quickOpenMatches } from "./quickOpenMatch"

const files = [
  { path: "docs/customer-model.mdx" },
  { path: "flows/signup.d2" },
  { path: "art/flow.excalidraw" },
  { path: "README.md" },
]

const rows = (query: string) =>
  quickOpenMatches(files, query).map(({ label, folder, ranges }) => ({ label, folder, ranges }))

describe("quickOpenMatches", () => {
  test("lists a name match before a match in the folders, and shows the path for the second", () => {
    expect(rows("flo")).toEqual([
      { label: "flow.excalidraw", folder: "art", ranges: [[0, 3]] },
      { label: "flows/signup.d2", folder: "flows", ranges: [[0, 3]] },
    ])
  })

  test("ignores case and surrounding spaces", () => {
    expect(rows("  ReadMe ")).toEqual([{ label: "README.md", folder: "", ranges: [[0, 6]] }])
    expect(rows("model")).toEqual([{ label: "customer-model.mdx", folder: "docs", ranges: [[9, 14]] }])
  })

  test("falls back to the letters in order, merging neighbours", () => {
    expect(rows("cumo")).toEqual([{ label: "customer-model.mdx", folder: "docs", ranges: [[0, 2], [5, 6], [10, 11]] }])
  })

  test("ranks letters in order in the name before letters in order in the path", () => {
    const scattered = [{ path: "s/d.md" }, { path: "sad.md" }]
    expect(quickOpenMatches(scattered, "sd").map(({ label, ranges }) => ({ label, ranges }))).toEqual([
      { label: "sad.md", ranges: [[0, 1], [2, 3]] },
      { label: "s/d.md", ranges: [[0, 1], [2, 3]] },
    ])
  })

  test("keeps the given order within a rank", () => {
    const recent = [{ path: "b/plan.md" }, { path: "a/plan.md" }]
    expect(quickOpenMatches(recent, "plan").map((row) => row.file.path)).toEqual(["b/plan.md", "a/plan.md"])
  })

  test("lists every file by name for an empty query, and nothing when no file matches", () => {
    expect(rows("").map((row) => row.label)).toEqual(["customer-model.mdx", "signup.d2", "flow.excalidraw", "README.md"])
    expect(rows("zzz")).toEqual([])
  })
})

describe("labelParts", () => {
  test("cuts a label into plain and matched parts", () => {
    expect(labelParts("customer-model.mdx", [[0, 1], [15, 18]])).toEqual([
      { text: "c", matched: true },
      { text: "ustomer-model.", matched: false },
      { text: "mdx", matched: true },
    ])
    expect(labelParts("README.md", [])).toEqual([{ text: "README.md", matched: false }])
  })
})
