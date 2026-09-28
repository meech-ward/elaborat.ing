import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { ProjectPath } from "../project-storage/model"
import { classify, RemoteError } from "../project-storage/remote"
import type { CommentAnchor } from "./placement"

/**
 * Comments as the database serves them (`supabase/schemas/comments.sql`),
 * called as the signed-in user. Every response is validated before it is
 * used. Comments need a connection: nothing here is queued or stored on the
 * device.
 */

const TextQuoteSelector = z.object({
  type: z.literal("TextQuoteSelector"),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
})

const TextPositionSelector = z.object({
  type: z.literal("TextPositionSelector"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})

/** An anchor as stored: exactly the shape of `CommentAnchor` in placement.ts. */
export const RemoteAnchor: z.ZodType<CommentAnchor> = z.union([
  z.object({ kind: z.literal("document") }),
  z.object({ kind: z.enum(["text", "section"]), quote: TextQuoteSelector, position: TextPositionSelector }),
  z.object({
    kind: z.literal("element"),
    element_id: z.string(),
    label: z.string(),
    point: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
])

/**
 * Someone who wrote or resolved a comment, or null for a deleted account.
 * `name` is the name they set or their sign-in provider gave, else their
 * email (older servers leave it out).
 */
const Person = z.object({ user_id: z.uuid(), email: z.string().nullable(), name: z.string().nullish() }).nullable()

/** A comment, or the placeholder a deleted one leaves (no body, `deleted_at` set). */
export const RemoteComment = z.object({
  id: z.uuid(),
  author: Person,
  /** Written by the author's agent rather than by them in the app. */
  via_agent: z.boolean(),
  body: z.string().nullable(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
})
export type RemoteComment = z.infer<typeof RemoteComment>

/**
 * A thread on one file, by the file's id. `path` is its current path, or the
 * last path of a deleted file (`file_deleted`). The first comment opens it.
 */
export const RemoteThread = z.object({
  id: z.uuid(),
  file_id: z.uuid(),
  path: ProjectPath,
  file_deleted: z.boolean(),
  file_version: z.number().int().positive(),
  anchor: RemoteAnchor,
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  resolved_by: Person,
  comments: z.array(RemoteComment),
})
export type RemoteThread = z.infer<typeof RemoteThread>

/** A project's threads, or one file's, with the project revision they were read at. */
export const CommentList = z.object({
  project_id: z.uuid(),
  revision: z.number().int().nonnegative(),
  threads: z.array(RemoteThread),
})
export type CommentList = z.infer<typeof CommentList>

const Revision = z.number().int().nonnegative()
const ThreadResult = z.object({ revision: Revision, thread: RemoteThread })
const CommentResult = z.object({ revision: Revision, comment: RemoteComment })
const DeletedComment = z.object({ revision: Revision, comment_id: z.uuid(), thread_deleted: z.boolean() })
const DeletedThread = z.object({ revision: Revision, thread_id: z.uuid(), deleted: z.literal(true) })

export type NewThread = {
  projectId: string
  /** Chosen by the caller, once per draft, so sending it again never starts a second thread. */
  threadId: string
  fileId: string
  /** The saved version of the file the anchor was described against. */
  fileVersion: number
  anchor: CommentAnchor
  body: string
}

/**
 * Every write returns the project revision after it. The caller marks it as
 * seen, so its own change signal does not cause a reload.
 */
export interface CommentsRemote {
  /** A project's threads, or one file's. Anyone who can read the project, viewers included. */
  list(projectId: string, fileId?: string): Promise<CommentList>
  /** Start a thread. Commenters, editors and the owner, agents included. Sent again after the thread was deleted, it fails as invalid. */
  add(input: NewThread): Promise<{ revision: number; thread: RemoteThread }>
  /** Reply with a caller-chosen id, so sending it again never posts twice. */
  reply(threadId: string, commentId: string, body: string): Promise<{ revision: number; comment: RemoteComment }>
  /** Change a comment's words. Its author only, never an agent. */
  edit(commentId: string, body: string): Promise<{ revision: number; comment: RemoteComment }>
  resolve(threadId: string): Promise<{ revision: number; thread: RemoteThread }>
  reopen(threadId: string): Promise<{ revision: number; thread: RemoteThread }>
  /** Delete a comment's words: its author or the owner, never an agent. The thread goes with its last live comment. */
  deleteComment(commentId: string): Promise<{ revision: number; comment_id: string; thread_deleted: boolean }>
  /** Delete a thread: the owner, or its creator while every live comment in it is theirs; never an agent. */
  deleteThread(threadId: string): Promise<{ revision: number; thread_id: string }>
}

/** The error for a request that got no answer. */
export function offline(): RemoteError {
  return new RemoteError("network", "Comments need a connection.")
}

export class SupabaseCommentsRemote implements CommentsRemote {
  constructor(private readonly supabase: Pick<SupabaseClient, "rpc">) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response
    try {
      response = await this.supabase.rpc(name, args)
    } catch {
      throw offline()
    }
    if (response.error) {
      const error = classify(response.error)
      throw error.kind === "network" ? offline() : error
    }
    return response.data
  }

  async list(projectId: string, fileId?: string) {
    return CommentList.parse(await this.rpc("list_comments", { project_id: projectId, ...(fileId ? { file_id: fileId } : {}) }))
  }

  async add(input: NewThread) {
    return ThreadResult.parse(
      await this.rpc("add_comment", {
        project_id: input.projectId,
        thread_id: input.threadId,
        file_id: input.fileId,
        file_version: input.fileVersion,
        anchor: input.anchor,
        body: input.body,
      }),
    )
  }

  async reply(threadId: string, commentId: string, body: string) {
    return CommentResult.parse(await this.rpc("reply_comment", { thread_id: threadId, comment_id: commentId, body }))
  }

  async edit(commentId: string, body: string) {
    return CommentResult.parse(await this.rpc("edit_comment", { comment_id: commentId, body }))
  }

  async resolve(threadId: string) {
    return ThreadResult.parse(await this.rpc("resolve_comment", { thread_id: threadId }))
  }

  async reopen(threadId: string) {
    return ThreadResult.parse(await this.rpc("reopen_comment", { thread_id: threadId }))
  }

  async deleteComment(commentId: string) {
    return DeletedComment.parse(await this.rpc("delete_comment", { comment_id: commentId }))
  }

  async deleteThread(threadId: string) {
    const { revision, thread_id } = DeletedThread.parse(await this.rpc("delete_comment_thread", { thread_id: threadId }))
    return { revision, thread_id }
  }
}
