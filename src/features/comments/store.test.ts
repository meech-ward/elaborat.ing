import { describe, expect, test } from "bun:test"
import { RemoteError } from "../project-storage/remote"
import { offline, type CommentList, type CommentsRemote, type NewThread, type RemoteComment, type RemoteThread } from "./remote"
import { ProjectComments } from "./store"

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e"
const A = "aaaaaaaa-0000-4000-8000-00000000000a"
const B = "aaaaaaaa-0000-4000-8000-00000000000b"
const USER = { user_id: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" }
const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`

/**
 * An in-memory comments server with the database's rules that the store
 * relies on: every change raises the revision by one, repeated ids return
 * what they made, and a deleted comment's thread goes with its last live one.
 */
class MemoryComments implements CommentsRemote {
  revision = 1
  threads: RemoteThread[] = []
  lists: string[] = []
  offline = false

  private answer<T>(value: T): Promise<T> {
    return this.offline ? Promise.reject(offline()) : Promise.resolve(structuredClone(value))
  }

  private comment(commentId: string, body: string): RemoteComment {
    return { id: commentId, author: USER, via_agent: false, body, created_at: `t${this.revision}`, edited_at: null, deleted_at: null }
  }

  private thread(threadId: string): RemoteThread {
    const found = this.threads.find((thread) => thread.id === threadId)
    if (!found) throw new RemoteError("access", "Comment unavailable")
    return found
  }

  list(_projectId: string, fileId?: string): Promise<CommentList> {
    this.lists.push(fileId ?? "project")
    return this.answer({ project_id: PROJECT, revision: this.revision, threads: this.threads.filter((thread) => !fileId || thread.file_id === fileId) })
  }

  add(input: NewThread) {
    const existing = this.threads.find((thread) => thread.id === input.threadId)
    if (existing) return this.answer({ revision: this.revision, thread: existing })
    this.revision++
    const thread: RemoteThread = {
      id: input.threadId,
      file_id: input.fileId,
      path: input.fileId === A ? "a.md" : "b.md",
      file_deleted: false,
      file_version: input.fileVersion,
      anchor: input.anchor,
      created_at: `t${this.revision}`,
      resolved_at: null,
      resolved_by: null,
      comments: [this.comment(id(900 + this.revision), input.body)],
    }
    this.threads.push(thread)
    return this.answer({ revision: this.revision, thread })
  }

  reply(threadId: string, commentId: string, body: string) {
    const thread = this.thread(threadId)
    const existing = thread.comments.find((comment) => comment.id === commentId)
    if (existing) return this.answer({ revision: this.revision, comment: existing })
    this.revision++
    const comment = this.comment(commentId, body)
    thread.comments.push(comment)
    return this.answer({ revision: this.revision, comment })
  }

  edit(commentId: string, body: string) {
    const comment = this.threads.flatMap((thread) => thread.comments).find((candidate) => candidate.id === commentId)!
    this.revision++
    Object.assign(comment, { body, edited_at: `t${this.revision}` })
    return this.answer({ revision: this.revision, comment })
  }

  private setResolved(threadId: string, resolved: boolean) {
    const thread = this.thread(threadId)
    this.revision++
    Object.assign(thread, { resolved_at: resolved ? `t${this.revision}` : null, resolved_by: resolved ? USER : null })
    return this.answer({ revision: this.revision, thread })
  }

  resolve(threadId: string) {
    return this.setResolved(threadId, true)
  }

  reopen(threadId: string) {
    return this.setResolved(threadId, false)
  }

  setAskAgent(threadId: string, ask: boolean) {
    const thread = this.thread(threadId)
    this.revision++
    thread.ask_agent = ask
    return this.answer({ revision: this.revision, thread })
  }

  deleteComment(commentId: string) {
    const thread = this.threads.find((candidate) => candidate.comments.some((comment) => comment.id === commentId))!
    this.revision++
    Object.assign(thread.comments.find((comment) => comment.id === commentId)!, { body: null, deleted_at: `t${this.revision}` })
    const threadDeleted = thread.comments.every((comment) => comment.deleted_at !== null)
    if (threadDeleted) this.threads = this.threads.filter((candidate) => candidate !== thread)
    return this.answer({ revision: this.revision, comment_id: commentId, thread_deleted: threadDeleted })
  }

  deleteThread(threadId: string) {
    this.revision++
    this.threads = this.threads.filter((thread) => thread.id !== threadId)
    return this.answer({ revision: this.revision, thread_id: threadId })
  }
}

/** A server with one thread on each file, and a store over it that records the revisions it reports. */
async function setup() {
  const server = new MemoryComments()
  await server.add({ projectId: PROJECT, threadId: id(1), fileId: A, fileVersion: 1, anchor: { kind: "document" }, body: "On A" })
  await server.add({ projectId: PROJECT, threadId: id(2), fileId: B, fileVersion: 1, anchor: { kind: "document" }, body: "On B" })
  const reported: number[] = []
  const store = new ProjectComments(server, PROJECT, (revision) => reported.push(revision))
  return { server, store, reported }
}

const bodies = (threads: readonly RemoteThread[]) => threads.map((thread) => thread.comments.map((comment) => comment.body))

describe("ProjectComments", () => {
  test("loads each file's threads on its own", async () => {
    const { server, store } = await setup()
    const seen: string[] = []
    store.subscribe(() => seen.push(store.status(A)))
    expect(store.status(A)).toBe("idle")
    await store.load(A)
    expect(seen).toEqual(["loading", "loaded"])
    expect(bodies(store.threads(A))).toEqual([["On A"]])
    expect(store.threads(B)).toEqual([])
    expect(store.status(B)).toBe("idle")
    expect(server.lists).toEqual([A])
  })

  test("writes update what it holds and report their revision, without a reload", async () => {
    const { server, store, reported } = await setup()
    await store.load(A)
    const added = await store.add({ threadId: id(3), fileId: A, fileVersion: 1, anchor: { kind: "document" }, body: "Second" })
    await store.reply(added.id, id(4), "A reply")
    await store.edit(id(4), "A reply, edited")
    await store.resolve(added.id)
    expect(store.threads(A)[1].resolved_at).not.toBeNull()
    await store.reopen(added.id)
    expect(await store.deleteComment(id(4))).toEqual({ threadDeleted: false })
    expect(store.threads(A)[1].comments.map((comment) => [comment.body, comment.deleted_at === null])).toEqual([
      ["Second", true],
      [null, false],
    ])
    await store.deleteThread(id(1))
    expect(bodies(store.threads(A))).toEqual([["Second", null]])
    expect(await store.deleteComment(store.threads(A)[0].comments[0].id)).toEqual({ threadDeleted: true })
    expect(store.threads(A)).toEqual([])
    expect(reported).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    await store.settled()
    expect(server.lists).toEqual([A])
    expect(store.threads(A)).toEqual(server.threads.filter((thread) => thread.file_id === A))
  })

  test("adding again with the same id does not add twice", async () => {
    const { server, store } = await setup()
    await store.load(A)
    const input = { threadId: id(3), fileId: A, fileVersion: 1, anchor: { kind: "document" as const }, body: "Once" }
    await store.add(input)
    await store.add(input)
    await store.settled()
    expect(bodies(store.threads(A))).toEqual([["On A"], ["Once"]])
    expect(server.threads).toHaveLength(3)
  })

  test("changed reloads the listed files only for a newer revision, once for a burst", async () => {
    const { server, store } = await setup()
    await store.load(A)
    await store.load(B)
    store.changed(server.revision)
    await store.settled()
    expect(server.lists).toEqual([A, B])

    // Someone else replies twice and resolves; three signals arrive together.
    await server.reply(id(2), id(5), "Elsewhere")
    await server.reply(id(2), id(6), "Again")
    await server.resolve(id(2))
    store.changed(server.revision - 2)
    store.changed(server.revision - 1)
    store.changed(server.revision)
    await store.settled()
    expect(server.lists).toEqual([A, B, A, B])
    expect(bodies(store.threads(B))).toEqual([["On B", "Elsewhere", "Again"]])
    expect(store.threads(B)[0].resolved_at).not.toBeNull()
  })

  test("refresh reloads the listed files even with no newer revision", async () => {
    const { server, store } = await setup()
    await store.load(A)
    store.refresh()
    await store.settled()
    expect(server.lists).toEqual([A, A])
    // A file never listed stays unlisted.
    expect(store.status(B)).toBe("idle")
  })

  test("a write after a change it has not heard of reloads", async () => {
    const { server, store } = await setup()
    await store.load(A)
    await server.reply(id(1), id(5), "Elsewhere")
    await store.reply(id(1), id(6), "Mine")
    await store.settled()
    expect(server.lists).toEqual([A, A])
    expect(bodies(store.threads(A))).toEqual([["On A", "Elsewhere", "Mine"]])
  })

  test("without a connection it keeps the last list and says why", async () => {
    const { server, store } = await setup()
    await store.load(A)
    server.offline = true
    await store.load(A)
    expect(store.status(A)).toBe("error")
    expect(store.error(A)).toMatchObject({ kind: "network", message: "Comments need a connection." })
    expect(bodies(store.threads(A))).toEqual([["On A"]])
    await expect(store.reply(id(1), id(7), "Hi")).rejects.toMatchObject({ kind: "network" })
    expect(bodies(store.threads(A))).toEqual([["On A"]])
  })
})
