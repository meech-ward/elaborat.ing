import type { AgentChangesRemote } from "./remote"

/** A change to open the view at: the file's server id and the version saved. */
export type AgentChangesFocus = { fileId: string; version: number }

export type AgentChangesState = {
  /** How many changes are new to the person, or null before the first count (or when it failed). */
  count: number | null
  /** The view is open. */
  open: boolean
  /** The change the view was opened at (from a comment's version link), or null. */
  focus: AgentChangesFocus | null
}

/** Wait this long after a change signal before counting again, so a burst of saves counts once. */
const RECOUNT_DELAY_MS = 500

/**
 * One open project's agent changes as its page shares them: the count of
 * changes new to the person (for the button's badge) and whether the view
 * is open, and at which change. Plain state and events, no React (context.tsx
 * reads it), and none of the view's code: the view loads in its own chunk.
 */
export class ProjectAgentChanges {
  private state: AgentChangesState = { count: null, open: false, focus: null }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private counting = 0

  constructor(
    readonly remote: AgentChangesRemote,
    readonly projectId: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): AgentChangesState => this.state

  /** Count the changes new to the person now. A failed count keeps the last one: the badge is only a hint. */
  async refresh(): Promise<void> {
    const attempt = ++this.counting
    try {
      const count = await this.remote.count(this.projectId)
      if (attempt === this.counting) this.set({ count })
    } catch {
      // Offline, or the project is no longer readable: the page says so elsewhere.
    }
  }

  /** Something changed in the project: count again shortly. */
  changed(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), RECOUNT_DELAY_MS)
  }

  /** Show the view, at a change when one is given. */
  show(focus: AgentChangesFocus | null = null): void {
    this.set({ open: true, focus })
  }

  close(): void {
    this.set({ open: false, focus: null })
  }

  /** The view marked everything up to now seen: none are new until the next count says otherwise. */
  markedSeen(): void {
    ++this.counting
    this.set({ count: 0 })
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  private set(change: Partial<AgentChangesState>) {
    const next = { ...this.state, ...change }
    if ((Object.keys(next) as (keyof AgentChangesState)[]).every((key) => next[key] === this.state[key])) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
