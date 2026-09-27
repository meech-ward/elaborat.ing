import { describe, expect, test } from "bun:test"
import { duplicatePath, nameStemLength, newFilePath, newFolderError, proposedName } from "./newEntries"

const taken = { files: ["a.md", "notes/untitled.md", "notes/plan.d2", "art/untitled.excalidraw"], dirs: ["notes", "art", "notes/old"] }

describe("proposedName", () => {
  test("starts from untitled with the kind's extension, and counts up past names taken in that folder", () => {
    expect(proposedName("note", "", taken.files)).toBe("untitled.md")
    expect(proposedName("note", "notes", taken.files)).toBe("untitled-2.md")
    expect(proposedName("mdx", "notes", taken.files)).toBe("untitled.mdx")
    expect(proposedName("drawing", "art", taken.files)).toBe("untitled-2.excalidraw")
    expect(proposedName("diagram", "art", taken.files)).toBe("untitled.d2")
    expect(proposedName("folder", "notes", taken.dirs)).toBe("untitled")
    expect(proposedName("note", "", ["UNTITLED.md"])).toBe("untitled-2.md")
  })

  test("selects the name up to its extension", () => {
    expect(nameStemLength("note", "untitled-2.md")).toBe("untitled-2".length)
    expect(nameStemLength("drawing", "untitled.excalidraw")).toBe("untitled".length)
    expect(nameStemLength("folder", "untitled")).toBe("untitled".length)
    // A name without the extension is selected whole.
    expect(nameStemLength("note", "ideas")).toBe(5)
  })
})

describe("newFilePath", () => {
  test("joins the name to the folder, adding the kind's extension when the name has none", () => {
    expect(newFilePath("note", "", "ideas", taken)).toEqual({ path: "ideas.md" })
    expect(newFilePath("note", "notes", "ideas.md", taken)).toEqual({ path: "notes/ideas.md" })
    expect(newFilePath("mdx", "notes", "ideas", taken)).toEqual({ path: "notes/ideas.mdx" })
    expect(newFilePath("drawing", "art", "sketch", taken)).toEqual({ path: "art/sketch.excalidraw" })
    expect(newFilePath("diagram", "", "flow.d2", taken)).toEqual({ path: "flow.d2" })
  })

  test("refuses a name that is taken by a file or a folder, whatever its case", () => {
    expect(newFilePath("note", "", "a", taken)).toEqual({ error: "a.md already exists here. Choose another name." })
    expect(newFilePath("note", "", "A.md", taken)).toEqual({ error: "A.md already exists here. Choose another name." })
    expect(newFilePath("diagram", "notes", "plan", taken)).toEqual({ error: "plan.d2 already exists here. Choose another name." })
  })

  test("refuses an empty or invalid name, or one of another kind", () => {
    expect(newFilePath("note", "", "", taken)).toEqual({ error: "Enter a name." })
    expect(newFilePath("note", "", " ideas", taken)).toEqual({ error: "Names cannot start or end with a space." })
    expect(newFilePath("note", "", "a/b", taken)).toEqual({ error: "Use one file name without separators, leading dots, or control characters." })
    expect(newFilePath("note", "", ".hidden", taken)).toEqual({ error: "Use one file name without separators, leading dots, or control characters." })
    expect(newFilePath("note", "", "ideas.d2", taken)).toEqual({ error: "A note's name ends with .md." })
    expect(newFilePath("mdx", "", "ideas.md", taken)).toEqual({ error: "An MDX note's name ends with .mdx." })
    expect(newFilePath("drawing", "", "sketch.excalidraw.md", taken)).toEqual({ error: "A drawing's name ends with .excalidraw." })
    expect(newFilePath("note", "", "sketch.excalidraw.md", taken)).toEqual({ error: "A note's name ends with .md." })
    expect(newFilePath("note", "", "my.notes", taken)).toEqual({ error: "A note's name ends with .md." })
  })
})

describe("newFolderError", () => {
  test("checks a folder name the way the new folder dialog did", () => {
    expect(newFolderError("notes", "drafts", taken)).toBeNull()
    expect(newFolderError("notes", "old", taken)).toBe('"old" already exists here. Choose another name.')
    expect(newFolderError("", "", taken)).toBe("Enter a folder name.")
  })
})

describe("duplicatePath", () => {
  test("adds copy before the extension in the same folder, then counts up past taken names", () => {
    expect(duplicatePath("a.md", ["a.md"])).toBe("a copy.md")
    expect(duplicatePath("notes/plan.md", ["notes/plan.md", "notes/plan copy.md", "NOTES/PLAN COPY 2.MD"])).toBe("notes/plan copy 3.md")
    expect(duplicatePath("Notes/Plan.MDX", [])).toBe("Notes/Plan copy.MDX")
    expect(duplicatePath("art/sketch.excalidraw", [])).toBe("art/sketch copy.excalidraw")
    // Compound extensions stay whole.
    expect(duplicatePath("wiki.excalidraw.md", [])).toBe("wiki copy.excalidraw.md")
    expect(duplicatePath("flow.d2.json", [])).toBe("flow copy.d2.json")
  })

  test("a diagram's copy also needs its generated files' names free", () => {
    expect(duplicatePath("flow.d2", ["flow.d2", "flow copy.excalidraw"])).toBe("flow copy 2.d2")
    expect(duplicatePath("flow.d2", ["flow.d2", "flow copy.d2.json"])).toBe("flow copy 2.d2")
    // A drawing's copy would become a diagram's generated canvas if that diagram exists.
    expect(duplicatePath("flow.excalidraw", ["flow copy.d2"])).toBe("flow copy 2.excalidraw")
  })
})
