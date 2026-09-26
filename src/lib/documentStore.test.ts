import { describe, expect, it } from "bun:test"
import { createDocumentStore } from "./documentStore"

const TEXT = "# Title\n\nSome prose.\n"

describe("createDocumentStore", () => {
  it("starts clean at revision 1", () => {
    const state = createDocumentStore(TEXT, "mdx").snapshot()
    expect(state).toEqual({ text: TEXT, revision: 1, format: "mdx", dirty: false, docId: 1 })
  })

  it("identical setText is a no-op: same revision, still clean", () => {
    const store = createDocumentStore(TEXT, "mdx")
    const state = store.setText(TEXT)
    expect(state.revision).toBe(1)
    expect(state.dirty).toBe(false)
  })

  it("changed setText bumps the revision and marks dirty", () => {
    const store = createDocumentStore(TEXT, "mdx")
    const state = store.setText(`${TEXT}More.\n`)
    expect(state.revision).toBe(2)
    expect(state.dirty).toBe(true)
  })

  it("replaceDocument clears dirty (opened file matches truth)", () => {
    const store = createDocumentStore(TEXT, "mdx")
    store.setText("edited")
    const state = store.replaceDocument("# Fresh\n", "md")
    expect(state).toEqual({ text: "# Fresh\n", revision: 3, format: "md", dirty: false, docId: 2 })
  })

  it("replaceDocument always advances the identity, even for identical bytes", () => {
    const store = createDocumentStore(TEXT, "mdx")
    const reopened = store.replaceDocument(TEXT, "mdx")
    expect(reopened.text).toBe(TEXT)
    expect(reopened.docId).toBe(2)
    expect(store.replaceDocument(TEXT, "mdx").docId).toBe(3)
  })

  it("typing, patches and save keep the document identity", () => {
    const store = createDocumentStore(TEXT, "mdx")
    expect(store.setText(`${TEXT}More.\n`).docId).toBe(1)
    expect(store.applyPatches(2, []).docId).toBe(1)
    expect(store.markSaved().docId).toBe(1)
    expect(store.snapshot().docId).toBe(1)
  })

  it("applies rendered patches through the checked document applier", () => {
    const store = createDocumentStore(TEXT, "mdx")
    const state = store.applyPatches(1, [
      { from: 2, to: 7, insert: "Heading", expected: "Title" },
    ])
    expect(state.text).toBe("# Heading\n\nSome prose.\n")
    expect(state.revision).toBe(2)
    expect(state.dirty).toBe(true)
  })

  it("empty patches keep the revision (no-op round trip)", () => {
    const store = createDocumentStore(TEXT, "mdx")
    const state = store.applyPatches(1, [])
    expect(state.revision).toBe(1)
    expect(state.dirty).toBe(false)
  })

  it("rejects stale revisions without touching the buffer", () => {
    const store = createDocumentStore(TEXT, "mdx")
    store.setText("edited once")
    expect(() =>
      store.applyPatches(1, [{ from: 0, to: 1, insert: "x", expected: "e" }]),
    ).toThrow(/stale revision/)
    expect(store.snapshot().text).toBe("edited once")
  })

  it("rejects expected-text mismatches without touching the buffer", () => {
    const store = createDocumentStore(TEXT, "mdx")
    expect(() =>
      store.applyPatches(1, [{ from: 0, to: 1, insert: "x", expected: "WRONG" }]),
    ).toThrow(/expected-text mismatch/)
    expect(store.snapshot().text).toBe(TEXT)
  })

  it("restoreUnsaved returns dirty: a stashed draft differs from the saved copy", () => {
    const store = createDocumentStore(TEXT, "mdx")
    store.setText("edited")
    const state = store.restoreUnsaved("edited", "mdx")
    expect(state.dirty).toBe(true)
    expect(state.text).toBe("edited")
    expect(state.docId).toBe(2)
  })

  it("markSaved clears dirty without moving the revision", () => {
    const store = createDocumentStore(TEXT, "mdx")
    store.setText("edited")
    const state = store.markSaved()
    expect(state).toEqual({ text: "edited", revision: 2, format: "mdx", dirty: false, docId: 1 })
  })
})
