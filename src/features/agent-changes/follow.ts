import { kindForPath } from "../workbench/session"
import type { AgentChangeList, AgentChangesRemote } from "./remote"

/** A save to follow: the file and the project revision it was saved at. */
export type AgentSave = { path: string; version: number }

/** Wait this long after a change signal before looking, so a burst of saves is looked at once and the latest is followed. */
const LOOK_DELAY_MS = 300

/**
 * In a chat's panel the open project follows the agent: the workbench opens
 * the note, drawing or diagram the person's agent saved last, so they watch
 * it work there. This finds that save. After each change signal it lists
 * the project's agent changes and keeps the newest one an agent saved for
 * this person (`userId`) to a note, drawing or diagram, after the panel first
 * looked. The person's own saves are never agent changes, and another
 * person's agent in a shared project is not followed. Plain state and
 * events, no React.
 */
export class AgentFollow {
  private save: AgentSave | null = null
  /** The project revision looked up to: saves at or below it are not followed. Null before the first look. */
  private seen: number | null = null
  private starting: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly remote: AgentChangesRemote,
    readonly projectId: string,
    readonly userId: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The newest save to follow, or null. A new save is a new object, even to the same file. */
  getState = (): AgentSave | null => this.save

  /** Something changed in the project: look again shortly. */
  changed(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), LOOK_DELAY_MS)
  }

  /**
   * Look now. The first look only notes where the project is: what agents
   * saved before it is not followed. A failed list is skipped, as following
   * is only a convenience; the next signal looks again.
   */
  async refresh(): Promise<void> {
    const first = this.starting === null
    await this.start()
    const seen = this.seen
    if (first || seen === null) return
    let list: AgentChangeList
    try {
      list = await this.remote.list(this.projectId)
    } catch {
      return
    }
    this.seen = Math.max(this.seen ?? seen, list.revision)
    // Newest first. Lists that answer out of order never go back to an older save.
    const save = list.changes.find(
      (change) => change.version > seen && !change.deleted && change.author?.user_id === this.userId && kindForPath(change.path) !== "text",
    )
    if (!save || (this.save && this.save.version >= save.version)) return
    this.save = { path: save.path, version: save.version }
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  /** The first look, once (again after a failed one). */
  private start(): Promise<void> {
    this.starting ??= this.remote.list(this.projectId).then(
      (list) => {
        this.seen ??= list.revision
      },
      () => {
        this.starting = null
      },
    )
    return this.starting
  }
}
