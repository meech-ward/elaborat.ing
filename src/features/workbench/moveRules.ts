import { validateWorkspacePath } from "@/features/workspace"

// Kept apart from movePlan.ts, which loads the MDX parser to find references:
// the explorer and the move and delete dialogs load that only when a move or
// delete is planned.

/** File kinds that can refer to other files, so a move may need to rewrite them. */
export function holdsReferences(path: string): boolean {
  return /\.(md|mdx|excalidraw|d2)$/i.test(path)
}

/**
 * Kinds of file the app edits (notes, drawings, diagrams and their JSON), at
 * paths references can name. Other files, such as ones an agent wrote, are
 * listed and open as text but are not renamed or moved here.
 */
export function canMove(path: string): boolean {
  return validateWorkspacePath(path.split("/").map(encodeURIComponent).join("/")) === path
}
