import type { ProjectEntry } from "@/features/project-storage/library"

/** Plain words for a project's sync state. */
export function statusLabel(entry: Pick<ProjectEntry, "status" | "stopped">): string {
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
