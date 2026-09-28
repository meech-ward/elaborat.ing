import { describe, expect, test } from "bun:test"
import { CommentsController, type CommentFile } from "./controller"
import { textAnchor } from "./placement"

const A: CommentFile = { path: "notes/a.md", fileId: "aaaaaaaa-0000-4000-8000-00000000000a", fileVersion: 3 }
const B: CommentFile = { path: "notes/b.md", fileId: "aaaaaaaa-0000-4000-8000-00000000000b", fileVersion: 5 }
const request = (file: CommentFile) => ({ file, anchor: textAnchor("Hello world", 0, 5), text: "Hello" })

describe("CommentsController", () => {
  test("the file on screen is the panel's; leaving clears it only for that file", () => {
    const controller = new CommentsController()
    controller.show({ path: A.path, file: A })
    controller.show({ path: B.path, file: B })
    controller.leave(A.path)
    expect(controller.getState().target).toEqual({ path: B.path, file: B })
    controller.leave(B.path)
    expect(controller.getState().target).toBeNull()
  })

  test("a marker opens the panel at its thread and asks the panel to focus it", () => {
    const controller = new CommentsController()
    const focused: string[] = []
    controller.onFocusThread((id) => focused.push(id))
    controller.openThread("t1")
    expect(controller.getState()).toMatchObject({ panelOpen: true, activeThreadId: "t1" })
    // Commented text clicked in the file: the keyboard stays there.
    controller.openThread("t2", false)
    expect(controller.getState()).toMatchObject({ panelOpen: true, activeThreadId: "t2" })
    expect(focused).toEqual(["t1"])
  })

  test("the new comment's text is shown in the file when asked, and only while there is one", () => {
    const controller = new CommentsController()
    const shown: unknown[] = []
    const stop = controller.onRevealRequest((asked) => shown.push(asked.anchor))
    controller.revealRequest()
    controller.requestComment(request(A))
    controller.revealRequest()
    stop()
    controller.revealRequest()
    expect(shown).toEqual([request(A).anchor])
    // Showing it leaves the new comment and the panel as they were.
    expect(controller.getState()).toMatchObject({ panelOpen: true, request: request(A) })
  })

  test("the panel reveals a thread in the file, which makes it the open one", () => {
    const controller = new CommentsController()
    const revealed: string[] = []
    const stop = controller.onReveal((id) => revealed.push(id))
    controller.reveal("t2")
    stop()
    controller.reveal("t3")
    expect(revealed).toEqual(["t2"])
    expect(controller.getState().activeThreadId).toBe("t3")
  })

  test("a new comment opens the panel; showing another file drops it and the open thread, a new version keeps them", () => {
    const controller = new CommentsController()
    controller.show({ path: A.path, file: A })
    controller.select("t1")
    controller.requestComment(request(A))
    expect(controller.getState()).toMatchObject({ panelOpen: true, activeThreadId: null, request: request(A) })
    controller.select("t1")
    controller.show({ path: A.path, file: { ...A, fileVersion: 4 } })
    expect(controller.getState()).toMatchObject({ activeThreadId: "t1", request: request(A) })
    controller.show({ path: B.path, file: B })
    expect(controller.getState()).toMatchObject({ activeThreadId: null, request: null })
  })

  test("a diagram's new comment on its canvas file stays while the diagram is on screen", () => {
    const code: CommentFile = { path: "flow.d2", fileId: "aaaaaaaa-0000-4000-8000-00000000000c", fileVersion: 2 }
    const canvas: CommentFile = { path: "flow.excalidraw", fileId: "aaaaaaaa-0000-4000-8000-00000000000d", fileVersion: 2 }
    const controller = new CommentsController()
    controller.show({ path: code.path, file: code, elements: canvas })
    const onNode = { file: canvas, anchor: { kind: "element" as const, element_id: "d2:a", label: "a" }, text: "a" }
    controller.requestComment(onNode)
    // Saving the diagram gives its canvas a new version: the target changes, the new comment stays.
    controller.show({ path: code.path, file: code, elements: { ...canvas, fileVersion: 3 } })
    expect(controller.getState()).toMatchObject({ target: { elements: { fileVersion: 3 } }, request: onNode })
    controller.show({ path: B.path, file: B })
    expect(controller.getState().request).toBeNull()
  })

  test("sending or giving up the new comment ends it; closing the panel ends both", () => {
    const controller = new CommentsController()
    controller.requestComment(request(A))
    controller.finishRequest("t9")
    expect(controller.getState()).toMatchObject({ request: null, activeThreadId: "t9" })
    controller.requestComment(request(A))
    controller.setPanelOpen(false)
    expect(controller.getState()).toMatchObject({ panelOpen: false, request: null, activeThreadId: null })
  })

  test("places are kept per file and notify only when they change", () => {
    const controller = new CommentsController()
    let changes = 0
    controller.subscribe(() => changes++)
    controller.place(A.fileId, new Map([["t1", { attached: true, text: "Hello", range: { start: 0, end: 5 } }]]))
    controller.place(A.fileId, new Map([["t1", { attached: true, text: "Hello", range: { start: 0, end: 5 } }]]))
    expect(changes).toBe(1)
    controller.place(A.fileId, new Map([["t1", { attached: false }]]))
    expect(changes).toBe(2)
    expect(controller.placesFor(A.fileId).get("t1")).toEqual({ attached: false })
    expect(controller.placesFor(B.fileId).size).toBe(0)
  })
})
