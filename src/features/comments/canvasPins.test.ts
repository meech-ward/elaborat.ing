import { describe, expect, test } from "bun:test"
import { anchorView } from "./anchorView"
import { canvasPins, canvasPlaces, nextPinThread, type CanvasElement } from "./canvasPins"
import { DRAFT_MARK } from "./noteMarks"
import type { CommentAnchor } from "./placement"
import type { RemoteThread } from "./remote"

const thread = (id: string, anchor: CommentAnchor, resolved = false): RemoteThread => ({
  id,
  file_id: "aaaaaaaa-0000-4000-8000-00000000000a",
  path: "art/flow.excalidraw",
  file_deleted: false,
  file_version: 1,
  anchor,
  created_at: "2026-09-27T00:00:00Z",
  resolved_at: resolved ? "2026-09-27T01:00:00Z" : null,
  resolved_by: null,
  comments: [],
})

const on = (element_id: string, label: string, point?: { x: number; y: number }): CommentAnchor => ({ kind: "element", element_id, label, ...(point ? { point } : {}) })

const SCENE: CanvasElement[] = [
  { id: "box", type: "rectangle" },
  { id: "box-label", type: "text", text: "Sign up", containerId: "box" },
  { id: "note", type: "text", text: "Later" },
  { id: "gone", type: "ellipse", isDeleted: true },
]

describe("canvas pins", () => {
  test("element threads are attached while their element is live, with its label as it is now", () => {
    const threads = [thread("t-box", on("box", "Sign-up")), thread("t-gone", on("gone", "Old idea")), thread("t-whole", { kind: "document" })]
    const places = canvasPlaces(threads, SCENE)
    expect(places.get("t-box")).toEqual({ attached: true, text: "Sign up" })
    expect(places.get("t-gone")).toEqual({ attached: false })
    expect(places.get("t-whole")).toEqual({ attached: true })
    // The panel shows the label now, and a gone element's stored label.
    expect(anchorView(threads[0].anchor, places.get("t-box"))).toEqual({ kind: "element", label: "Sign up" })
    expect(anchorView(threads[1].anchor, places.get("t-gone"))).toEqual({ kind: "element", label: "Old idea", detached: true })
  })

  test("one pin per element and spot, for open threads on live elements; the open thread's is active", () => {
    const threads = [
      thread("t1", on("box", "Sign up")),
      thread("t2", on("box", "Sign up")),
      thread("t3", on("box", "Sign up", { x: 0.2, y: 0.5 })),
      thread("t4", on("note", "Later"), true),
      thread("t5", on("gone", "Old idea")),
    ]
    const pins = canvasPins(threads, canvasPlaces(threads, SCENE), "t2", null)
    expect(pins.map(({ elementId, point, threadIds, label, active }) => ({ elementId, point, threadIds, label, active }))).toEqual([
      { elementId: "box", point: undefined, threadIds: ["t1", "t2"], label: "2 threads on Sign up", active: true },
      { elementId: "box", point: { x: 0.2, y: 0.5 }, threadIds: ["t3"], label: "1 thread on Sign up", active: false },
    ])
  })

  test("a new comment on an element has its own pin; one on the whole file has none", () => {
    const draft = canvasPins([], new Map(), null, { anchor: on("note", "Later", { x: 0.5, y: 0.5 }), label: "Later" })
    expect(draft).toEqual([{ id: DRAFT_MARK, elementId: "note", point: { x: 0.5, y: 0.5 }, threadIds: [], label: "New comment on Later", active: true }])
    expect(canvasPins([], new Map(), null, { anchor: { kind: "document" }, label: "Whole drawing" })).toEqual([])
  })

  test("a pin with several threads opens the one after the open one", () => {
    const pin = { id: "p", elementId: "box", threadIds: ["t1", "t2", "t3"], label: "", active: false }
    expect(nextPinThread(pin, null)).toBe("t1")
    expect(nextPinThread(pin, "t1")).toBe("t2")
    expect(nextPinThread(pin, "t3")).toBe("t1")
    expect(nextPinThread(pin, "elsewhere")).toBe("t1")
    expect(nextPinThread({ ...pin, threadIds: [] }, null)).toBeNull()
  })
})
