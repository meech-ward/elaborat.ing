import type { WorkspaceFileRef } from "@/features/workbench/workspaceStore"

/** Formats with a rendered file-sharing page. Unknown text files stay private. */
export function supportsFileSharing(path: string): boolean {
  return /\.(?:md|mdx|excalidraw|d2|png|jpe?g|webp|gif|svg)$/i.test(path)
}

/** A share always starts from a saved, synchronized file, never a draft. */
export function fileSharingProblem(file: WorkspaceFileRef | null | undefined, dirty = false): string | null {
  if (!file || !supportsFileSharing(file.path)) return "This file does not have a rendered sharing view."
  if (/\.(?:png|jpe?g|webp|gif|svg)$/i.test(file.path) && file.kind !== "image") return "Import this image as an image file before sharing it."
  if (!file.server || !file.revision) return "Save and sync this file before sharing it."
  if (file.conflict) return "Resolve this file's sync conflict before sharing it."
  if (file.unsynced) return "Sync this file before sharing it."
  if (file.draft || dirty) return "Save or discard this file's unsaved changes before sharing it."
  return null
}
