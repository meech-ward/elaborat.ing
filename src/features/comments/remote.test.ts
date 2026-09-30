import { describe, expect, test } from "bun:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import { RemoteError } from "../project-storage/remote"
import { SupabaseCommentsRemote, type RemoteThread } from "./remote"

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"
const FILE = "aaaaaaaa-0000-4000-8000-000000000001"
const THREAD = "bbbbbbbb-0000-4000-8000-000000000001"
const COMMENT = "cccccccc-0000-4000-8000-000000000001"
const USER = "11111111-1111-4111-8111-111111111111"
const TIME = "2026-09-27T00:00:00+00:00"

const comment = {
  id: COMMENT,
  author: { user_id: USER, email: "ada@example.com" },
  via_agent: false,
  body: "Is this right?",
  created_at: TIME,
  edited_at: null,
  deleted_at: null,
}

const thread: RemoteThread = {
  id: THREAD,
  file_id: FILE,
  path: "notes/plan.md",
  file_deleted: false,
  file_version: 3,
  anchor: {
    kind: "text",
    quote: { type: "TextQuoteSelector", exact: "plan", prefix: "The ", suffix: "." },
    position: { type: "TextPositionSelector", start: 4, end: 8 },
  },
  created_at: TIME,
  resolved_at: null,
  resolved_by: null,
  comments: [comment],
}

type Response = { data: unknown; error: { code?: string; message?: string } | null }

/** A remote over a stand-in client that records each call and answers with `respond`. */
function remote(respond: (name: string) => Response | Promise<Response>) {
  const calls: [string, unknown][] = []
  const supabase = {
    rpc(name: string, args: unknown) {
      calls.push([name, args])
      return Promise.resolve(respond(name))
    },
  }
  return { remote: new SupabaseCommentsRemote(supabase as unknown as SupabaseClient), calls }
}

const answers: Record<string, unknown> = {
  list_comments: { project_id: PROJECT, revision: 7, threads: [thread] },
  add_comment: { revision: 8, thread },
  reply_comment: { revision: 9, comment },
  edit_comment: { revision: 10, comment },
  resolve_comment: { revision: 11, thread: { ...thread, resolved_at: TIME, resolved_by: { user_id: USER, email: "ada@example.com" } } },
  reopen_comment: { revision: 12, thread },
  set_comment_ask_agent: { revision: 15, thread: { ...thread, ask_agent: true } },
  delete_comment: { revision: 13, comment_id: COMMENT, thread_deleted: false },
  delete_comment_thread: { revision: 14, thread_id: THREAD, deleted: true },
}

describe("SupabaseCommentsRemote", () => {
  test("calls each database function with its arguments and parses the answer", async () => {
    const { remote: comments, calls } = remote((name) => ({ data: answers[name], error: null }))
    expect(await comments.list(PROJECT)).toEqual(answers.list_comments as never)
    await comments.list(PROJECT, FILE)
    expect((await comments.add({ projectId: PROJECT, threadId: THREAD, fileId: FILE, fileVersion: 3, anchor: { kind: "document" }, body: "Hi" })).revision).toBe(8)
    expect((await comments.reply(THREAD, COMMENT, "Yes")).comment.id).toBe(COMMENT)
    await comments.edit(COMMENT, "Yes, edited")
    expect((await comments.resolve(THREAD)).thread.resolved_by?.email).toBe("ada@example.com")
    await comments.reopen(THREAD)
    expect(await comments.deleteComment(COMMENT)).toEqual({ revision: 13, comment_id: COMMENT, thread_deleted: false })
    expect(await comments.deleteThread(THREAD)).toEqual({ revision: 14, thread_id: THREAD })
    await comments.add({ projectId: PROJECT, threadId: THREAD, fileId: FILE, fileVersion: 3, anchor: { kind: "document" }, body: "Hi", askAgent: true })
    expect((await comments.setAskAgent(THREAD, true)).thread.ask_agent).toBe(true)
    expect(calls).toEqual([
      ["list_comments", { project_id: PROJECT }],
      ["list_comments", { project_id: PROJECT, file_id: FILE }],
      ["add_comment", { project_id: PROJECT, thread_id: THREAD, file_id: FILE, file_version: 3, anchor: { kind: "document" }, body: "Hi" }],
      ["reply_comment", { thread_id: THREAD, comment_id: COMMENT, body: "Yes" }],
      ["edit_comment", { comment_id: COMMENT, body: "Yes, edited" }],
      ["resolve_comment", { thread_id: THREAD }],
      ["reopen_comment", { thread_id: THREAD }],
      ["delete_comment", { comment_id: COMMENT }],
      ["delete_comment_thread", { thread_id: THREAD }],
      ["add_comment", { project_id: PROJECT, thread_id: THREAD, file_id: FILE, file_version: 3, anchor: { kind: "document" }, body: "Hi", ask_agent: true }],
      ["set_comment_ask_agent", { thread_id: THREAD, ask: true }],
    ])
  })

  test("reads a deleted comment, a deleted account and each kind of anchor", async () => {
    const threads = [
      { ...thread, comments: [{ ...comment, author: null, body: null, deleted_at: TIME }] },
      { ...thread, anchor: { kind: "document" } },
      { ...thread, file_deleted: true, anchor: { kind: "element", element_id: "box", label: "Start", point: { x: 0.5, y: 1 } } },
    ]
    const { remote: comments } = remote(() => ({ data: { project_id: PROJECT, revision: 7, threads }, error: null }))
    expect((await comments.list(PROJECT)).threads).toEqual(threads as never)
  })

  test("refuses an answer of the wrong shape", async () => {
    const wrong = [
      { project_id: PROJECT, revision: 7, threads: [{ ...thread, anchor: { kind: "page" } }] },
      { project_id: PROJECT, revision: 7, threads: [{ ...thread, comments: [{ ...comment, via_agent: "no" }] }] },
      { project_id: PROJECT, threads: [] },
    ]
    for (const data of wrong) {
      const { remote: comments } = remote(() => ({ data, error: null }))
      await expect(comments.list(PROJECT)).rejects.toThrow()
    }
  })

  test("classifies refusals as sync does", async () => {
    const cases: [string, string][] = [
      ["42501", "access"],
      ["55000", "archived"],
      ["54000", "limit"],
      ["PT429", "account-limit"],
      ["22023", "invalid"],
    ]
    for (const [code, kind] of cases) {
      const { remote: comments } = remote(() => ({ data: null, error: { code, message: `refused ${code}` } }))
      const error = await comments.reply(THREAD, COMMENT, "Hi").catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(RemoteError)
      expect(error).toMatchObject({ kind, message: `refused ${code}` })
    }
  })

  test("a request with no answer needs a connection", async () => {
    const thrown = remote(() => Promise.reject(new TypeError("fetch failed")))
    await expect(thrown.remote.list(PROJECT)).rejects.toMatchObject({ kind: "network", message: "Comments need a connection." })
    const unanswered = remote(() => ({ data: null, error: { code: "", message: "TypeError: Failed to fetch" } }))
    await expect(unanswered.remote.add({ projectId: PROJECT, threadId: THREAD, fileId: FILE, fileVersion: 3, anchor: { kind: "document" }, body: "Hi" }))
      .rejects.toMatchObject({ kind: "network", message: "Comments need a connection." })
  })
})
