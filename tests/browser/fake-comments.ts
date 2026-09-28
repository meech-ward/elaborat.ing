import type { FakeProjectServer } from "../../src/features/project-storage/fakeServer.ts"
import { RemoteError } from "../../src/features/project-storage/remote.ts"

/**
 * The comment functions of `supabase/schemas/comments.sql`, in memory, over
 * the fake project server's projects and files: who may read and write, the
 * retry rules for caller-chosen ids, placeholders for deleted comments, and
 * a revision bump for every change (none for a no-op). Messages are the
 * database's, so the app shows what it would show.
 */

type Thread = {
  id: string
  projectId: string
  fileId: string
  /** The file's path when last seen, kept for a deleted file. */
  path: string
  fileVersion: number
  anchor: unknown
  createdBy: string
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

type Comment = {
  id: string
  threadId: string
  authorId: string
  body: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
}

type Args = Record<string, unknown>

const MAX_BODY = 5000
const ANCHOR_KEYS: Record<string, string[]> = {
  document: ["kind"],
  text: ["kind", "quote", "position"],
  section: ["kind", "quote", "position"],
  element: ["kind", "element_id", "label", "point"],
}

export class FakeComments {
  readonly threads: Thread[] = []
  readonly comments: Comment[] = []
  private ticks = 0

  constructor(private readonly server: FakeProjectServer) {}

  /** Whether `rpc` is one of the comment functions. */
  static handles(rpc: string): boolean {
    return [
      "list_comments",
      "add_comment",
      "reply_comment",
      "edit_comment",
      "resolve_comment",
      "reopen_comment",
      "delete_comment",
      "delete_comment_thread",
    ].includes(rpc)
  }

  /** Call a comment function as `user`, as the app's rpc does. Throws RemoteError as the database refuses. */
  call(user: string, rpc: string, args: Args): unknown {
    if (this.server.offline) throw new RemoteError("network", "Failed to fetch")
    if (this.server.limited) throw new RemoteError("account-limit", this.server.limited)
    switch (rpc) {
      case "list_comments":
        return this.list(user, String(args.project_id), typeof args.file_id === "string" ? args.file_id : null)
      case "add_comment":
        return this.add(user, args)
      case "reply_comment":
        return this.reply(user, String(args.thread_id), String(args.comment_id), args.body)
      case "edit_comment":
        return this.edit(user, String(args.comment_id), args.body)
      case "resolve_comment":
        return this.setResolved(user, String(args.thread_id), true)
      case "reopen_comment":
        return this.setResolved(user, String(args.thread_id), false)
      case "delete_comment":
        return this.deleteComment(user, String(args.comment_id))
      case "delete_comment_thread":
        return this.deleteThread(user, String(args.thread_id))
    }
    throw new Error(`No fake for ${rpc}`)
  }

  private project(projectId: string) {
    return this.server.projects.get(projectId)
  }

  private tick(): string {
    return new Date(Date.UTC(2026, 8, 27, 12, 0, ++this.ticks)).toISOString()
  }

  /** The project for a read: any member. */
  private readable(user: string, projectId: string) {
    const project = this.project(projectId)
    if (!project || !this.server.role(user, project)) throw new RemoteError("access", "Project unavailable")
    return project
  }

  /** The project for a write: a commenter, editor or owner, then not archived (unless the write is an exact retry). */
  private writable(user: string, projectId: string, allowArchived = false) {
    const project = this.project(projectId)
    const role = project ? this.server.role(user, project) : null
    if (!project || !role) throw new RemoteError("access", "Project unavailable")
    if (role === "viewer") throw new RemoteError("access", "Commenting needs commenter access")
    if (project.archivedAt && !allowArchived) throw new RemoteError("archived", "Project is archived")
    return project
  }

  private thread(user: string, threadId: string): Thread {
    const thread = this.threads.find((candidate) => candidate.id === threadId)
    const project = thread && this.project(thread.projectId)
    if (!thread || !project || !this.server.role(user, project)) throw new RemoteError("access", "Comment unavailable")
    return thread
  }

  private comment(user: string, commentId: string): Comment {
    const comment = this.comments.find((candidate) => candidate.id === commentId)
    if (!comment) throw new RemoteError("access", "Comment unavailable")
    this.thread(user, comment.threadId)
    return comment
  }

  private bump(projectId: string): number {
    const project = this.project(projectId)!
    project.revision++
    return project.revision
  }

  private person(userId: string | null) {
    return userId === null ? null : { user_id: userId, email: this.server.emails.get(userId) ?? null }
  }

  private threadJson(thread: Thread) {
    const project = this.project(thread.projectId)!
    const file = [...project.files.values()].find((candidate) => candidate.id === thread.fileId)
    if (file) thread.path = file.path
    return {
      id: thread.id,
      file_id: thread.fileId,
      path: thread.path,
      file_deleted: file === undefined,
      file_version: thread.fileVersion,
      anchor: thread.anchor,
      created_at: thread.createdAt,
      resolved_at: thread.resolvedAt,
      resolved_by: this.person(thread.resolvedBy),
      comments: this.comments.filter((comment) => comment.threadId === thread.id).map((comment) => this.commentJson(comment)),
    }
  }

  private commentJson(comment: Comment) {
    return {
      id: comment.id,
      author: this.person(comment.authorId),
      via_agent: false,
      body: comment.body,
      created_at: comment.createdAt,
      edited_at: comment.editedAt,
      deleted_at: comment.deletedAt,
    }
  }

  private checkBody(body: unknown): string {
    if (typeof body !== "string" || body.length < 1 || body.length > MAX_BODY || !/\S/.test(body)) {
      throw new RemoteError("invalid", "A comment is 1 to 5000 characters")
    }
    return body
  }

  private checkAnchor(anchor: unknown) {
    const record = anchor && typeof anchor === "object" ? (anchor as Record<string, unknown>) : null
    const allowed = record && typeof record.kind === "string" ? ANCHOR_KEYS[record.kind] : undefined
    if (!record || !allowed || Object.keys(record).some((key) => !allowed.includes(key))) throw new RemoteError("invalid", "Invalid anchor")
    if (record.kind === "text" || record.kind === "section") {
      const quote = record.quote as Record<string, unknown> | undefined
      const position = record.position as Record<string, unknown> | undefined
      const exact = quote?.exact
      const valid =
        quote?.type === "TextQuoteSelector" &&
        typeof exact === "string" &&
        exact.length >= 1 &&
        exact.length <= 5000 &&
        typeof quote.prefix === "string" &&
        quote.prefix.length <= 32 &&
        typeof quote.suffix === "string" &&
        quote.suffix.length <= 32 &&
        position?.type === "TextPositionSelector" &&
        Number.isInteger(position.start) &&
        Number.isInteger(position.end) &&
        (position.start as number) >= 0 &&
        (position.start as number) < (position.end as number)
      if (!valid) throw new RemoteError("invalid", "Invalid anchor")
    }
  }

  private list(user: string, projectId: string, fileId: string | null) {
    const project = this.readable(user, projectId)
    const threads = this.threads.filter((thread) => thread.projectId === projectId && (fileId === null || thread.fileId === fileId))
    return { project_id: projectId, revision: project.revision, threads: threads.map((thread) => this.threadJson(thread)) }
  }

  private add(user: string, args: Args) {
    const body = this.checkBody(args.body)
    this.checkAnchor(args.anchor)
    const projectId = String(args.project_id)
    const project = this.writable(user, projectId, true)
    const existing = this.threads.find((thread) => thread.id === args.thread_id)
    if (existing) {
      if (existing.projectId === projectId && existing.fileId === args.file_id && existing.createdBy === user) {
        return { revision: project.revision, thread: this.threadJson(existing) }
      }
      throw new RemoteError("invalid", "This comment id was already used")
    }
    if (project.archivedAt) throw new RemoteError("archived", "Project is archived")
    const file = [...project.files.values()].find((candidate) => candidate.id === args.file_id)
    if (!file) throw new RemoteError("invalid", "No such file in this project")
    const createdAt = this.tick()
    const thread: Thread = {
      id: String(args.thread_id),
      projectId,
      fileId: file.id,
      path: file.path,
      fileVersion: Number(args.file_version),
      anchor: structuredClone(args.anchor),
      createdBy: user,
      createdAt,
      resolvedAt: null,
      resolvedBy: null,
    }
    this.threads.push(thread)
    this.comments.push({ id: crypto.randomUUID(), threadId: thread.id, authorId: user, body, createdAt, editedAt: null, deletedAt: null })
    return { revision: this.bump(projectId), thread: this.threadJson(thread) }
  }

  private reply(user: string, threadId: string, commentId: string, rawBody: unknown) {
    const body = this.checkBody(rawBody)
    const thread = this.thread(user, threadId)
    const project = this.writable(user, thread.projectId, true)
    const existing = this.comments.find((comment) => comment.id === commentId)
    if (existing) {
      if (existing.threadId === threadId && existing.authorId === user) return { revision: project.revision, comment: this.commentJson(existing) }
      throw new RemoteError("invalid", "This comment id was already used")
    }
    if (project.archivedAt) throw new RemoteError("archived", "Project is archived")
    const comment: Comment = { id: commentId, threadId, authorId: user, body, createdAt: this.tick(), editedAt: null, deletedAt: null }
    this.comments.push(comment)
    return { revision: this.bump(thread.projectId), comment: this.commentJson(comment) }
  }

  private edit(user: string, commentId: string, rawBody: unknown) {
    const body = this.checkBody(rawBody)
    const comment = this.comment(user, commentId)
    const thread = this.thread(user, comment.threadId)
    const project = this.writable(user, thread.projectId)
    if (comment.authorId !== user) throw new RemoteError("access", "Only its author can edit a comment")
    if (comment.deletedAt) throw new RemoteError("invalid", "This comment was deleted")
    if (comment.body === body) return { revision: project.revision, comment: this.commentJson(comment) }
    comment.body = body
    comment.editedAt = this.tick()
    return { revision: this.bump(thread.projectId), comment: this.commentJson(comment) }
  }

  private setResolved(user: string, threadId: string, resolved: boolean) {
    const thread = this.thread(user, threadId)
    const project = this.writable(user, thread.projectId)
    if ((thread.resolvedAt !== null) === resolved) return { revision: project.revision, thread: this.threadJson(thread) }
    thread.resolvedAt = resolved ? this.tick() : null
    thread.resolvedBy = resolved ? user : null
    return { revision: this.bump(thread.projectId), thread: this.threadJson(thread) }
  }

  private deleteComment(user: string, commentId: string) {
    const comment = this.comment(user, commentId)
    const thread = this.thread(user, comment.threadId)
    const project = this.writable(user, thread.projectId)
    if (comment.authorId !== user && project.owner !== user) {
      throw new RemoteError("access", "Only its author or the project owner can delete a comment")
    }
    if (comment.deletedAt) return { revision: project.revision, comment_id: commentId, thread_deleted: false }
    comment.body = null
    comment.deletedAt = this.tick()
    const live = this.comments.some((candidate) => candidate.threadId === thread.id && candidate.deletedAt === null)
    if (!live) this.removeThread(thread.id)
    return { revision: this.bump(thread.projectId), comment_id: commentId, thread_deleted: !live }
  }

  private deleteThread(user: string, threadId: string) {
    const thread = this.thread(user, threadId)
    const project = this.writable(user, thread.projectId)
    const others = this.comments.some((comment) => comment.threadId === threadId && comment.deletedAt === null && comment.authorId !== user)
    if (project.owner !== user && (thread.createdBy !== user || others)) {
      throw new RemoteError("access", "Only the project owner can delete a thread with other people's comments")
    }
    this.removeThread(threadId)
    return { revision: this.bump(thread.projectId), thread_id: threadId, deleted: true }
  }

  private removeThread(threadId: string) {
    this.threads.splice(
      this.threads.findIndex((thread) => thread.id === threadId),
      1,
    )
    for (let index = this.comments.length - 1; index >= 0; index--) {
      if (this.comments[index].threadId === threadId) this.comments.splice(index, 1)
    }
  }
}
