import type { ProjectEntry } from "@/features/project-storage/library"
import type { SaveStatus } from "@/features/design-system"
import { stoppedSyncMessage } from "@/features/project-storage/syncDiagnostics"

/** Plain words for a project's sync state. */
export function statusLabel(entry: Pick<ProjectEntry, "status" | "stopped" | "stoppedDetail">, syncing = false): string {
  if (syncing) return "Syncing changes with the server"
  switch (entry.status) {
    case "not-downloaded":
      return "On the server"
    case "synced":
      return "Synced"
    case "unsynced":
      return "Saved on this device, waiting to sync"
    case "conflict":
      return "Changed in two places: choose which version to keep"
    case "stopped":
      if (entry.stoppedDetail && entry.stopped) return stoppedSyncMessage(entry.stopped, entry.stoppedDetail)
      switch (entry.stopped) {
        case "access-lost":
          return "You no longer have access; your copy stays on this device"
        case "archived":
          return "Archived"
        case "limit":
          return "Over the project's limits"
        default:
          return "The server refused a change"
      }
  }
}

/** The sync state for a status dot: the dot, the words it shows, and the whole sentence. */
export interface SyncState {
  status: SaveStatus
  text: string
  label: string
}

/**
 * The sync state as the account panel's status dot shows it: the dot, a
 * word or two to show, and the whole sentence (statusLabel) for screen
 * readers and the tooltip.
 */
export function syncDot(entry: Pick<ProjectEntry, "status" | "stopped" | "stoppedDetail">, offline: boolean, syncing = false): SyncState {
  if (syncing) return { status: "unsaved", text: "Syncing", label: statusLabel(entry, true) }
  const label = statusLabel(entry)
  if (offline) return { status: "offline", text: "Offline", label: `${label} (offline)` }
  switch (entry.status) {
    case "synced":
      return { status: "synced", text: "Synced", label }
    case "unsynced":
      return { status: "unsaved", text: "Waiting to sync", label }
    case "conflict":
      return { status: "failed", text: "Conflict", label }
    case "not-downloaded":
      return { status: "offline", text: "On the server", label }
    case "stopped":
      return entry.stopped === "archived" ? { status: "offline", text: "Archived", label } : { status: "failed", text: "Not synced", label }
  }
}
