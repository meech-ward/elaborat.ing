import { describe, expect, it } from "bun:test"
import {
  applyReload,
  editorLanguageForPath,
  initialOpenFile,
  kindForPath,
  markConflict,
  markSaved,
  markSaving,
  newUntitledNote,
  openWorkspaceFile,
  resolveSaveCompletion,
  saveTarget,
  suggestUntitledName,
} from "./session"

describe("kindForPath", () => {
  it("routes notes, drawings, diagrams and plain text to their views", () => {
    expect(kindForPath("notes/a.md")).toBe("note")
    expect(kindForPath("notes/a.MDX")).toBe("note")
    expect(kindForPath("drawings/a.excalidraw")).toBe("drawing")
    expect(kindForPath("drawings/a.excalidraw.md")).toBe("drawing")
    expect(kindForPath("diagrams/a.d2")).toBe("diagram")
    expect(kindForPath("sidecar.json")).toBe("text")
  })
})

describe("resolveSaveCompletion", () => {
  it("keeps async save completion on the captured document identity", () => {
    expect(
      resolveSaveCompletion(
        { docId: 2, path: "notes/a.md", text: "saved" },
        { docId: 2, text: "saved" },
      ),
    ).toEqual({ outcome: "saved-current" })
    expect(
      resolveSaveCompletion(
        { docId: 2, path: "notes/a.md", text: "saved" },
        { docId: 2, text: "saved plus newer typing" },
      ),
    ).toEqual({ outcome: "saved-with-newer-edits" })
    // A different file opened mid-save: same bytes must not mark it saved.
    expect(
      resolveSaveCompletion(
        { docId: 2, path: "notes/a.md", text: "same bytes" },
        { docId: 3, text: "same bytes" },
      ),
    ).toEqual({ outcome: "saved-other-file", path: "notes/a.md" })
  })
})

describe("editorLanguageForPath", () => {
  it("maps notes, scenes, diagrams and plain text", () => {
    expect(editorLanguageForPath("notes/a.md")).toBe("markdown")
    expect(editorLanguageForPath("notes/a.mdx")).toBe("mdx")
    expect(editorLanguageForPath("drawings/a.excalidraw")).toBe("json")
    expect(editorLanguageForPath("drawings/a.excalidraw.md")).toBe("markdown")
    expect(editorLanguageForPath("diagrams/a.d2")).toBe("d2")
    expect(editorLanguageForPath("sidecar.json")).toBe("json")
    expect(editorLanguageForPath("notes/a.txt")).toBe("plaintext")
  })
})

describe("suggestUntitledName", () => {
  it("picks untitled.md then numbered variants", () => {
    expect(suggestUntitledName([])).toBe("notes/untitled.md")
    expect(suggestUntitledName(["notes/untitled.md"])).toBe("notes/untitled-2.md")
    expect(suggestUntitledName(["notes/untitled.md", "notes/untitled-2.md"])).toBe("notes/untitled-3.md")
  })

  it("names in an explicit folder or at the workspace root, never /untitled.md", () => {
    expect(suggestUntitledName([], ".md", "documents/customer-model")).toBe(
      "documents/customer-model/untitled.md",
    )
    expect(suggestUntitledName([], ".md", "")).toBe("untitled.md")
    expect(suggestUntitledName(["untitled.md"], ".md", "")).toBe("untitled-2.md")
  })
})

describe("open-file lifecycle", () => {
  it("opens with the read revision and clears save state on save", () => {
    let file = openWorkspaceFile("notes/a.md", "rev1")
    expect(saveTarget(file)).toBe("notes/a.md")
    file = markSaving(file)
    expect(file.save.stage).toBe("saving")
    file = markSaved(file, "notes/a.md", "rev2")
    expect(file.baseRevision).toBe("rev2")
    expect(file.save).toEqual({ stage: "idle" })
  })

  it("tracks a not-yet-created note by pending name", () => {
    const file = newUntitledNote("notes/untitled.md")
    expect(saveTarget(file)).toBe("notes/untitled.md")
    expect(file.baseRevision).toBeNull()
    const saved = markSaved(file, "notes/untitled.md", "rev1")
    expect(saved.path).toBe("notes/untitled.md")
    expect(saved.pendingName).toBeNull()
  })

  it("records conflicts with the saved text", () => {
    const file = markConflict(openWorkspaceFile("notes/a.md", "rev1"), {
      currentRevision: "rev9",
      currentContent: "server text",
    })
    expect(file.save).toEqual({ stage: "conflict", currentRevision: "rev9", currentContent: "server text" })
    expect(file.baseRevision).toBe("rev1")
  })

  it("initial state is an unsaved idle note", () => {
    expect(initialOpenFile().save).toEqual({ stage: "idle" })
    expect(saveTarget(initialOpenFile())).toBeNull()
  })
})

describe("applyReload", () => {
  it("adopts the server text when the buffer is clean", () => {
    const { file, adopt } = applyReload(openWorkspaceFile("notes/a.md", "rev1"), { revision: "rev2", content: "new" }, false)
    expect(adopt).toBe(true)
    expect(file.baseRevision).toBe("rev2")
    expect(file.serverChanged).toBeNull()
  })

  it("adopts when nothing changed on the server", () => {
    const { file, adopt } = applyReload(openWorkspaceFile("notes/a.md", "rev1"), { revision: "rev1", content: "same" }, true)
    expect(adopt).toBe(true)
    expect(file.serverChanged).toBeNull()
  })

  it("flags instead of replacing when dirty and the server moved", () => {
    const { file, adopt } = applyReload(openWorkspaceFile("notes/a.md", "rev1"), { revision: "rev2", content: "theirs" }, true)
    expect(adopt).toBe(false)
    expect(file.serverChanged).toEqual({ currentRevision: "rev2", currentContent: "theirs" })
    expect(file.baseRevision).toBe("rev1")
  })
})
