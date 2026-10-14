import { describe, expect, test } from "bun:test"
import { linkedFile, resolveNoteLink } from "./noteLinks"

describe("resolveNoteLink", () => {
  test("a path is relative to the note's folder", () => {
    expect(resolveNoteLink("brainstorm/marble.mdx", "README.mdx")).toEqual({ kind: "file", path: "brainstorm/marble.mdx" })
    expect(resolveNoteLink("marble.mdx", "brainstorm/README.mdx")).toEqual({ kind: "file", path: "brainstorm/marble.mdx" })
    expect(resolveNoteLink("./marble.mdx", "brainstorm/README.mdx")).toEqual({ kind: "file", path: "brainstorm/marble.mdx" })
    expect(resolveNoteLink("../reference/hardware.md", "brainstorm/README.mdx")).toEqual({ kind: "file", path: "reference/hardware.md" })
  })

  test("a leading slash starts at the project's root", () => {
    expect(resolveNoteLink("/reference/hardware.md", "brainstorm/README.mdx")).toEqual({ kind: "file", path: "reference/hardware.md" })
  })

  test("escapes, a query and a heading are read off the path", () => {
    expect(resolveNoteLink("notes/my%20plan.md#goals", "README.mdx")).toEqual({ kind: "file", path: "notes/my plan.md" })
    expect(resolveNoteLink("notes/plan.md?x=1", "README.mdx")).toEqual({ kind: "file", path: "notes/plan.md" })
  })

  test("web and mail links open outside the app", () => {
    expect(resolveNoteLink("https://supabase.com/docs", "README.mdx")).toEqual({ kind: "web", url: "https://supabase.com/docs" })
    expect(resolveNoteLink("HTTP://example.com", "README.mdx")).toEqual({ kind: "web", url: "http://example.com/" })
    expect(resolveNoteLink("mailto:sam@example.com", "README.mdx")).toEqual({ kind: "web", url: "mailto:sam@example.com" })
  })

  test("other schemes, other sites, headings, the root's parent and broken escapes go nowhere", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.example/x", "#start-here", "", "  ", "../outside.md", "/", "bad%E0%A4%A.md"]) {
      expect(resolveNoteLink(href, "README.mdx")).toEqual({ kind: "none" })
    }
  })
})

describe("linkedFile", () => {
  const files = ["README.mdx", "brainstorm/marble.mdx", "reference/hardware.md", "diagrams/flow.d2"]

  test("the path itself, when the project has it", () => {
    expect(linkedFile("brainstorm/marble.mdx", files)).toBe("brainstorm/marble.mdx")
    expect(linkedFile("diagrams/flow.d2", files)).toBe("diagrams/flow.d2")
  })

  test("a link without an extension finds the note it means", () => {
    expect(linkedFile("brainstorm/marble", files)).toBe("brainstorm/marble.mdx")
    expect(linkedFile("reference/hardware", files)).toBe("reference/hardware.md")
  })

  test("nothing for a file the project doesn't have", () => {
    expect(linkedFile("brainstorm/missing.mdx", files)).toBeNull()
    expect(linkedFile("brainstorm", files)).toBeNull()
  })
})
