import type { ProjectEntry } from "@/features/project-storage/library"
import { canEdit } from "@/features/project-storage/model"

/**
 * Why a project cannot be changed on this device, or null when it can. The
 * file store refuses the same changes: an archived project's, and any from a
 * viewer or commenter (who is told they can comment).
 */
export function readOnlyReason(entry: Pick<ProjectEntry, "archived" | "role"> | undefined): string | null {
  if (!entry) return null
  if (entry.archived) {
    return canEdit(entry.role) ? "This project is archived. Unarchive it to make changes." : "This project is archived, so it cannot be changed."
  }
  if (canEdit(entry.role)) return null
  return entry.role === "commenter" ? "You can comment on this project but not change it." : "You can view this project but not change it."
}
