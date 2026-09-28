import { describe, expect, it } from "bun:test"
import type { SourcePatch } from "@/features/document"
import { createSourceBuffer, createSourceHandoff, type SourceEditorApi } from "./sourceBuffer"

const insert = (at: number, value: string): SourcePatch => ({ from: at, to: at, insert: value, expected: "" })
const replace = (text: string, from: number, to: number, value: string): SourcePatch => ({ from, to, insert: value, expected: text.slice(from, to) })

function buffer(initial: string) {
  const heard: string[] = []
  return { heard, buffer: createSourceBuffer(initial, (text) => heard.push(text)) }
}

describe("createSourceBuffer", () => {
  it("applies patches against the text before them, and reports each change", () => {
    const { buffer: b, heard } = buffer("one two three")
    b.applyPatches([replace("one two three", 0, 3, "ONE"), replace("one two three", 8, 13, "THREE")])
    expect(b.getValue()).toBe("ONE two THREE")
    expect(heard).toEqual(["ONE two THREE"])
  })

  it("undoes a group of rendered patches as one step and ungrouped ones one at a time, newest first", () => {
    const { buffer: b } = buffer("ab")
    b.applyPatches([insert(2, "c")], { group: "s:1", before: { anchor: 2, head: 2 }, after: { anchor: 3, head: 3 } })
    b.applyPatches([insert(3, "d")], { group: "s:1", after: { anchor: 4, head: 4 } })
    b.applyPatches([insert(0, "-")])
    expect(b.getValue()).toBe("-abcd")
    expect(b.history("undo", false).text).toBe("abcd")
    // The group's step returns the selection from before its first patch.
    expect(b.history("undo", false)).toEqual({ text: "ab", selection: { anchor: 2, head: 2 } })
    expect(b.history("undo", false).text).toBe("ab")
    // Redo restores the selection after the group's last patch.
    expect(b.history("redo", false)).toEqual({ text: "abcd", selection: { anchor: 4, head: 4 } })
    expect(b.history("redo", false).text).toBe("-abcd")
  })

  it("starts a new step when the group changes, and after undo or redo", () => {
    const { buffer: b } = buffer("")
    b.applyPatches([insert(0, "a")], { group: "s:1" })
    b.applyPatches([insert(1, "b")], { group: "s:2" })
    b.history("undo", false)
    b.history("redo", false)
    b.applyPatches([insert(2, "c")], { group: "s:2" })
    expect(b.history("undo", false).text).toBe("ab")
    expect(b.history("undo", false).text).toBe("a")
  })

  it("drops what could be redone when an edit follows an undo", () => {
    const { buffer: b } = buffer("x")
    b.applyPatches([insert(1, "1")])
    b.history("undo", false)
    b.applyPatches([insert(1, "2")])
    expect(b.history("redo", false).text).toBe("x2")
    expect(b.getValue()).toBe("x2")
  })

  it("leaves the text alone for undo and redo while read-only", () => {
    const { buffer: b, heard } = buffer("x")
    b.applyPatches([insert(1, "1")])
    expect(b.history("undo", true).text).toBe("x1")
    expect(heard).toEqual(["x1"])
    expect(b.steps().map((step) => step.kind)).toEqual(["patches"])
  })

  it("keeps a format as one step of its own that ends the rendered group", () => {
    const { buffer: b } = buffer("a")
    b.applyPatches([insert(1, "b")], { group: "s:1" })
    b.replaceAll("# ab\n")
    b.applyPatches([insert(5, "c")], { group: "s:1" })
    expect(b.history("undo", false).text).toBe("# ab\n")
    expect(b.history("undo", false).text).toBe("ab")
    expect(b.history("undo", false).text).toBe("a")
  })

  it("records the steps to replay from its base, and an outside replacement starts over", () => {
    const { buffer: b, heard } = buffer("a")
    b.applyPatches([insert(1, "b")], { group: "s:1" })
    b.history("undo", false)
    b.replaceAll("A")
    expect(b.base()).toBe("a")
    expect(b.steps()).toEqual([
      { kind: "patches", patches: [insert(1, "b")], options: { group: "s:1" } },
      { kind: "history", direction: "undo" },
      { kind: "format", text: "A" },
    ])
    b.setValue("reloaded")
    expect(heard.at(-1)).toBe("reloaded")
    expect(b.base()).toBe("reloaded")
    expect(b.steps()).toEqual([])
    expect(b.history("undo", false).text).toBe("reloaded")
  })
})

describe("createSourceHandoff", () => {
  function handoff(text = "a") {
    const heard: string[] = []
    const onChange = (next: string) => void heard.push(next)
    const h = createSourceHandoff(text, 1)
    h.connect({ onChange, readOnly: false })
    return { h, heard, setReadOnly: (readOnly: boolean) => h.connect({ onChange, readOnly }) }
  }

  it("keeps edits in the buffer until the editor attaches, and sends every call to the editor after", () => {
    const { h, heard, setReadOnly } = handoff("a")
    h.api.applyExternalPatches([insert(1, "b")])
    expect(heard).toEqual(["ab"])
    setReadOnly(true)
    expect(h.api.history("undo").text).toBe("ab")
    setReadOnly(false)
    expect(h.api.history("undo").text).toBe("a")

    const calls: string[] = []
    const editor: SourceEditorApi = {
      formatSource: async () => (calls.push("format"), true),
      applyExternalPatches: () => void calls.push("patch"),
      history: (direction) => (calls.push(direction), { text: "", selection: { anchor: 0, head: 0 } }),
      focus: () => void calls.push("focus"),
      revealRange: (from, to, focus) => void calls.push(`reveal ${from}-${to} ${focus}`),
    }
    h.api.revealRange(0, 1, true)
    h.attach(editor)
    expect(h.attached()).toBe(true)
    h.api.applyExternalPatches([insert(1, "c")])
    h.api.history("redo")
    h.api.focus()
    expect(calls).toEqual(["reveal 0-1 true", "patch", "redo", "focus"])
    expect(h.buffer.getValue()).toBe("a")
    h.detach()
    expect(h.attached()).toBe(false)
  })

  it("tells the parent's echo of a buffer edit from an outside replacement", () => {
    const { h, heard } = handoff("a")
    h.api.applyExternalPatches([insert(1, "b")])
    h.api.applyExternalPatches([insert(2, "c")])
    // The parent acknowledges the older text after the newer edit: not a replacement.
    expect(h.documentSync.receive(h.buffer, { text: "ab", docId: 1 })).toBe(false)
    expect(h.buffer.getValue()).toBe("abc")
    expect(h.api.history("undo").text).toBe("ab")
    // A reload with other text replaces the buffer and its history.
    expect(h.documentSync.receive(h.buffer, { text: "saved", docId: 2 })).toBe(true)
    expect(heard.at(-1)).toBe("saved")
    expect(h.buffer.steps()).toEqual([])
  })

  it("formats in the buffer as one undoable step", async () => {
    const { h } = handoff("#   Title\n\nText")
    expect(await h.api.formatSource()).toBe(true)
    expect(h.buffer.getValue()).toBe("# Title\n\nText\n")
    expect(await h.api.formatSource()).toBe(false)
    expect(h.api.history("undo").text).toBe("#   Title\n\nText")
  })
})
