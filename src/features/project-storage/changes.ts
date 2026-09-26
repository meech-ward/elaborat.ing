import type { RealtimeChannel, REALTIME_SUBSCRIBE_STATES, SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

/**
 * Hears when an open project changes somewhere else.
 *
 * Whenever a project's revision goes up, the database broadcasts the new
 * revision on the private Realtime channel `project:<id>`, which only people
 * who can read the project may join (`supabase/schemas/change_signals.sql`).
 * A signal says nothing about which files changed: on a newer revision, pull
 * with `ProjectSync.refresh()`.
 *
 * Realtime does not replay signals sent while this device was disconnected.
 * A caller that must not miss a change refreshes whenever `onStatus` reports
 * `SUBSCRIBED`, which happens on every join, including rejoins.
 */

/** A signal's payload. Realtime adds a message `id`, which is not needed here. */
const ChangeSignal = z.object({ revision: z.number().int().positive() })

export function projectChangesTopic(projectId: string): string {
  return `project:${projectId}`
}

export class ProjectChanges {
  private latest: number
  private closed = false
  private readonly channel: RealtimeChannel

  /**
   * Joins the channel for one project. `revision` is the newest revision this
   * device already has; `onNewer` is called with each newer one announced.
   */
  constructor(
    private readonly supabase: Pick<SupabaseClient, "channel" | "removeChannel">,
    readonly projectId: string,
    revision: number,
    private readonly onNewer: (revision: number) => void,
    onStatus?: (status: REALTIME_SUBSCRIBE_STATES, error?: Error) => void,
  ) {
    this.latest = revision
    this.channel = supabase
      .channel(projectChangesTopic(projectId), { config: { private: true } })
      .on("broadcast", { event: "changed" }, (message) => this.receive(message.payload))
      .subscribe(onStatus)
  }

  /** Notes a revision this device got another way, such as from its own save, so it is not announced again. */
  seen(revision: number): void {
    this.latest = Math.max(this.latest, revision)
  }

  /** Leaves the channel. `onNewer` is not called after this. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.supabase.removeChannel(this.channel)
  }

  private receive(payload: unknown) {
    if (this.closed) return
    const signal = ChangeSignal.safeParse(payload)
    if (!signal.success || signal.data.revision <= this.latest) return
    this.latest = signal.data.revision
    this.onNewer(signal.data.revision)
  }
}
