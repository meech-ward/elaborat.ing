import { describe, expect, it } from "bun:test"
import { createModelDocumentSync, languageForFormat, syncModelDocument, syncModelText } from "./modelSync"

function fakeModel(initial: string) {
  let current = initial
  const calls: string[] = []
  return {
    calls,
    model: {
      getValue: () => current,
      setValue: (value: string) => {
        current = value
        calls.push(value)
      },
    },
  }
}

describe("languageForFormat", () => {
  it("maps md to markdown and mdx to mdx", () => {
    expect(languageForFormat("md")).toBe("markdown")
    expect(languageForFormat("mdx")).toBe("mdx")
  })
})

describe("syncModelText", () => {
  it("leaves an identical model alone (typing/patch path)", () => {
    const { calls, model } = fakeModel("same")
    expect(syncModelText(model, "same")).toBe(false)
    expect(calls).toEqual([])
  })

  it("replaces a stale model on file open", () => {
    const { calls, model } = fakeModel("demo")
    expect(syncModelText(model, "opened file")).toBe(true)
    expect(calls).toEqual(["opened file"])
  })
})

describe("syncModelDocument", () => {
  it("does not overwrite newer keystrokes with a delayed parent echo", () => {
    const { calls, model } = fakeModel("")
    const sync = createModelDocumentSync({text:"",docId:1})
    model.setValue("O"); sync.emitted("O")
    model.setValue("OF"); sync.emitted("OF")
    calls.length = 0
    expect(sync.receive(model,{text:"O",docId:1})).toBe(false)
    expect(model.getValue()).toBe("OF")
    expect(sync.receive(model,{text:"OF",docId:1})).toBe(false)
    expect(calls).toEqual([])
    // A subsequent real external same-document replacement still applies.
    expect(sync.receive(model,{text:"server replacement",docId:1})).toBe(true)
    expect(model.getValue()).toBe("server replacement")
  })

  it("external identity wins over pending typing and always isolates undo", () => {
    const { calls, model } = fakeModel("typed")
    const sync = createModelDocumentSync({text:"",docId:1})
    sync.emitted("typed")
    expect(sync.receive(model,{text:"typed",docId:2})).toBe(true)
    expect(calls).toEqual(["typed"])
    expect(sync.receive(model,{text:"replacement",docId:2})).toBe(true)
  })

  it("unchanged parent state and batched acknowledgements do not reset model history", () => {
    const { calls, model } = fakeModel("ABC")
    const sync = createModelDocumentSync({text:"",docId:1})
    sync.emitted("A"); sync.emitted("AB"); sync.emitted("ABC")
    expect(sync.receive(model,{text:"",docId:1})).toBe(false)
    expect(sync.receive(model,{text:"ABC",docId:1})).toBe(false)
    expect(calls).toEqual([])
    expect(sync.receive(model,{text:"AB",docId:1})).toBe(true)
  })
  it("resets the model on document identity change even when bytes match", () => {
    // Reopening the same bytes must still isolate the old file's undo.
    const { calls, model } = fakeModel("same bytes")
    expect(syncModelDocument(model, { text: "same bytes", docId: 1 }, { text: "same bytes", docId: 2 })).toBe(true)
    expect(calls).toEqual(["same bytes"])
  })

  it("replaces text on identity change with different bytes", () => {
    const { calls, model } = fakeModel("old")
    expect(syncModelDocument(model, { text: "old", docId: 1 }, { text: "new", docId: 2 })).toBe(true)
    expect(calls).toEqual(["new"])
  })

  it("leaves an identical model alone on the same document", () => {
    const { calls, model } = fakeModel("same")
    expect(syncModelDocument(model, { text: "same", docId: 1 }, { text: "same", docId: 1 })).toBe(false)
    expect(calls).toEqual([])
  })
})
