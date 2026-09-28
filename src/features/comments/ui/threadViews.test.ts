import { describe, expect, test } from "bun:test"
import type { ThreadPlace } from "../controller"
import { sectionAnchor, textAnchor } from "../placement"
import type { RemoteComment, RemoteThread } from "../remote"
import { fileNoun, newComments, threadViews, type Viewer } from "./threadViews"

const FILE = "aaaaaaaa-0000-4000-8000-00000000000a"
const ME = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`
const SOURCE = "# Plan\n\nShip the panel first.\n\n## Steps\n\nThen the markers.\n"
const SHIP = "Ship the panel first."
const at = (text: string) => SOURCE.indexOf(text)

function comment(n: number, user: string | null, body: string | null = "Hi", viaAgent = false): RemoteComment {
  return {
    id: id(n),
    author: user ? { user_id: user, email: user === ME ? "me@example.com" : "ada@example.com" } : null,
    via_agent: viaAgent,
    body,
    created_at: "2026-09-27T10:00:00Z",
    edited_at: null,
    deleted_at: body === null ? "2026-09-27T11:00:00Z" : null,
  }
}

function thread(n: number, anchor: RemoteThread["anchor"], comments: RemoteComment[], resolved = false): RemoteThread {
  return {
    id: id(100 + n),
    file_id: FILE,
    path: "plan.md",
    file_deleted: false,
    file_version: 1,
    anchor,
    created_at: `2026-09-27T0${n}:00:00Z`,
    resolved_at: resolved ? "2026-09-27T12:00:00Z" : null,
    resolved_by: resolved ? { user_id: OTHER, email: "ada@example.com" } : null,
    comments,
  }
}

const me: Viewer = { userId: ME, owner: false }
const owner: Viewer = { userId: ME, owner: true }
const NONE = new Map<string, ThreadPlace>()

describe("threadViews", () => {
  const steps = thread(1, sectionAnchor(SOURCE, at("## Steps")), [comment(1, OTHER)])
  const ship = thread(2, textAnchor(SOURCE, at(SHIP), at(SHIP) + SHIP.length), [comment(2, ME), comment(3, OTHER)])
  const whole = thread(3, { kind: "document" }, [comment(4, OTHER)])
  const done = thread(4, { kind: "document" }, [comment(5, OTHER)], true)
  const threads = [steps, ship, whole, done]

  test("lists the whole file first, then by place in the file, and keeps resolved apart", () => {
    const { open, resolved } = threadViews(threads, NONE, me, "note")
    expect(open.map((view) => view.id)).toEqual([whole.id, ship.id, steps.id])
    expect(resolved.map((view) => view.id)).toEqual([done.id])
    expect(resolved[0].resolved).toEqual({ by: { name: "ada@example.com" }, at: "2026-09-27T12:00:00Z" })
  })

  test("describes each anchor as the file on screen placed it", () => {
    const places = new Map<string, ThreadPlace>([
      [ship.id, { attached: true, text: "Ship the panel first!", range: { start: 40, end: 61 } }],
      [steps.id, { attached: true, text: "## Steps", range: { start: 2, end: 10 } }],
    ])
    const { open } = threadViews(threads, places, me, "drawing")
    expect(open.map((view) => view.anchor)).toEqual([
      { kind: "document", label: "Whole drawing" },
      { kind: "section", heading: "Steps" },
      { kind: "text", quote: "Ship the panel first!" },
    ])
  })

  test("threads whose text is gone are detached and keep their place, where their text was", () => {
    const places = new Map<string, ThreadPlace>([
      [ship.id, { attached: false }],
      [steps.id, { attached: true, range: { start: at("## Steps") - SHIP.length, end: at("## Steps") - SHIP.length + 8 } }],
    ])
    const { open } = threadViews(threads, places, me, "note")
    expect(open.map((view) => [view.id, view.detached])).toEqual([
      [whole.id, false],
      [ship.id, true],
      [steps.id, false],
    ])
    expect(open[1].anchor).toEqual({ kind: "text", quote: SHIP, detached: true })
  })

  test("people edit their own comments; they and the owner delete them", () => {
    const [mine, theirs] = threadViews([ship], NONE, me, "note").open[0].comments
    expect([mine.canEdit, mine.canDelete, theirs.canEdit, theirs.canDelete]).toEqual([true, true, false, false])
    const [, asOwner] = threadViews([ship], NONE, owner, "note").open[0].comments
    expect([asOwner.canEdit, asOwner.canDelete]).toEqual([false, true])
  })

  test("a deleted account and a deleted comment", () => {
    const view = threadViews([thread(7, { kind: "document" }, [comment(8, null, null), comment(9, OTHER)])], NONE, me, "note").open[0]
    expect(view.comments[0]).toMatchObject({ author: null, body: null, canEdit: false, canDelete: false })
  })
})

test("files are called what they are", () => {
  expect(["a.md", "a.mdx", "a.excalidraw", "a.excalidraw.md", "a.d2", "a.json"].map(fileNoun)).toEqual(["note", "note", "drawing", "drawing", "diagram", "file"])
})

test("new comments count what came from elsewhere, not the viewer's own", () => {
  const threads = [
    thread(1, { kind: "document" }, [comment(1, OTHER), comment(2, ME), comment(3, ME, "From my agent", true), comment(4, OTHER, null)]),
  ]
  expect(newComments(threads, new Set(), me)).toBe(2)
  expect(newComments(threads, new Set([id(1)]), me)).toBe(1)
})
