import { RemoteError } from "../project-storage/remote"
import { offline, type CommentsRemote, type NewThread, type RemoteComment, type RemoteThread } from "./remote"

/**
 * The comments of one open project, per file, in memory only. Comments need a
 * connection: nothing is queued or kept on the device, so after a reload
 * while offline there are none until the next list succeeds.
 *
 * The page calls `changed()` with each newer revision it hears about (the
 * project's change signal, the same one that drives sync), and passes
 * `onRevision` on to `ProjectChanges.seen()`, so this store's own writes do
 * not cause a reload.
 */

export type CommentsStatus = "idle" | "loading" | "loaded" | "error"

type FileComments = {
  status: CommentsStatus
  threads: RemoteThread[]
  /** The project revision the threads were listed at. */
  revision: number
  error: RemoteError | null
}

const NO_THREADS: readonly RemoteThread[] = []

export class ProjectComments {
  private readonly files = new Map<string, FileComments>()
  private readonly listeners = new Set<() => void>()
  private reloading: Promise<void> | null = null
  private newest = 0
  private again = false

  constructor(
    private readonly remote: CommentsRemote,
    readonly projectId: string,
    private readonly onRevision: (revision: number) => void = () => {},
  ) {}

  /** Calls `listener` after every change to what this store holds. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A file's threads, oldest first, as last listed or written here. */
  threads(fileId: string): readonly RemoteThread[] {
    return this.files.get(fileId)?.threads ?? NO_THREADS
  }

  status(fileId: string): CommentsStatus {
    return this.files.get(fileId)?.status ?? "idle"
  }

  /** Why the last list of a file failed, while its status is "error". */
  error(fileId: string): RemoteError | null {
    return this.files.get(fileId)?.error ?? null
  }

  /** Lists a file's threads. A failure keeps what was listed before and reports the error. */
  async load(fileId: string): Promise<void> {
    const file: FileComments = this.files.get(fileId) ?? { status: "idle", threads: [], revision: -1, error: null }
    this.files.set(fileId, { ...file, status: "loading" })
    this.notify()
    try {
      const list = await this.remote.list(this.projectId, fileId)
      this.files.set(fileId, { status: "loaded", threads: list.threads, revision: list.revision, error: null })
    } catch (error) {
      const current = this.files.get(fileId) ?? file
      this.files.set(fileId, { ...current, status: "error", error: error instanceof RemoteError ? error : offline() })
    }
    this.notify()
  }

  /**
   * The project is at `revision` now. Reloads every file listed before it,
   * one reload at a time: signals that arrive during a reload make one more
   * reload after it, if the first did not already see their revision.
   */
  changed(revision: number): void {
    this.newest = Math.max(this.newest, revision)
    if (this.reloading) {
      this.again = true
      return
    }
    const stale = [...this.files].filter(([, file]) => file.status !== "idle" && file.revision < this.newest).map(([id]) => id)
    if (stale.length === 0) return
    this.reloading = Promise.all(stale.map((fileId) => this.load(fileId))).then(() => {
      this.reloading = null
      if (this.again) {
        this.again = false
        this.changed(this.newest)
      }
    })
  }

  /**
   * Reloads every file listed before, whatever its revision: for when
   * signals may have been missed, such as each time the change channel
   * (re)joins. A reload already running is followed by one more.
   */
  refresh(): void {
    for (const [fileId, file] of this.files) this.files.set(fileId, { ...file, revision: -1 })
    this.changed(this.newest)
  }

  /** Resolves once no reload is running. For tests and callers that need a settled store. */
  async settled(): Promise<void> {
    while (this.reloading) await this.reloading
  }

  /** Starts a thread. Sending the same `threadId` again returns the same thread. */
  async add(input: Omit<NewThread, "projectId">): Promise<RemoteThread> {
    const { revision, thread } = await this.remote.add({ ...input, projectId: this.projectId })
    this.written(revision, thread.file_id, (threads) => upsert(threads, thread))
    return thread
  }

  /** Replies to a thread. Sending the same `commentId` again returns the same comment. */
  async reply(threadId: string, commentId: string, body: string): Promise<RemoteComment> {
    const { revision, comment } = await this.remote.reply(threadId, commentId, body)
    this.writtenOnThread(revision, threadId, (thread) => ({ ...thread, comments: upsert(thread.comments, comment) }))
    return comment
  }

  async edit(commentId: string, body: string): Promise<RemoteComment> {
    const { revision, comment } = await this.remote.edit(commentId, body)
    this.writtenOnThread(revision, this.threadOf(commentId), (thread) => ({ ...thread, comments: upsert(thread.comments, comment) }))
    return comment
  }

  async resolve(threadId: string): Promise<RemoteThread> {
    const { revision, thread } = await this.remote.resolve(threadId)
    this.written(revision, thread.file_id, (threads) => upsert(threads, thread))
    return thread
  }

  async reopen(threadId: string): Promise<RemoteThread> {
    const { revision, thread } = await this.remote.reopen(threadId)
    this.written(revision, thread.file_id, (threads) => upsert(threads, thread))
    return thread
  }

  /** Deletes a comment's words. It stays as a placeholder while its thread has live comments. */
  async deleteComment(commentId: string): Promise<{ threadDeleted: boolean }> {
    const threadId = this.threadOf(commentId)
    const { revision, thread_deleted } = await this.remote.deleteComment(commentId)
    const deletedAt = new Date().toISOString()
    this.writtenOnThread(revision, threadId, (thread) =>
      thread_deleted
        ? null
        : {
            ...thread,
            comments: thread.comments.map((comment) =>
              comment.id === commentId && comment.deleted_at === null ? { ...comment, body: null, deleted_at: deletedAt } : comment,
            ),
          },
    )
    return { threadDeleted: thread_deleted }
  }

  async deleteThread(threadId: string): Promise<void> {
    const { revision } = await this.remote.deleteThread(threadId)
    this.writtenOnThread(revision, threadId, () => null)
  }

  /** The id of the thread holding a comment, among the listed files. */
  private threadOf(commentId: string): string | null {
    for (const file of this.files.values()) {
      for (const thread of file.threads) if (thread.comments.some((comment) => comment.id === commentId)) return thread.id
    }
    return null
  }

  /** Applies a write to the thread with this id, wherever it is listed; null removes the thread. */
  private writtenOnThread(revision: number, threadId: string | null, change: (thread: RemoteThread) => RemoteThread | null) {
    const fileId = [...this.files].find(([, file]) => file.threads.some((thread) => thread.id === threadId))?.[0] ?? null
    this.written(revision, fileId, (threads) =>
      threads.flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const changed = change(thread)
        return changed ? [changed] : []
      }),
    )
  }

  /**
   * Applies a write's result to a listed file, then reports the revision. A
   * write right after the file's list keeps it current; after a gap, other
   * changes may have happened in between, and their signals are now seen, so
   * listed files are reloaded.
   */
  private written(revision: number, fileId: string | null, change: (threads: RemoteThread[]) => RemoteThread[]) {
    const file = fileId === null ? undefined : this.files.get(fileId)
    const current = file !== undefined && file.status === "loaded" && revision === file.revision + 1
    if (file && fileId !== null) {
      this.files.set(fileId, { ...file, threads: change(file.threads), revision: current ? revision : file.revision })
      this.notify()
    }
    this.onRevision(revision)
    if (!current) this.changed(revision)
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

/** `items` with `item` in place of the one with its id, or added at the end. */
function upsert<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item]
}
