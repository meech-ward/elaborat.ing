/**
 * A clean session cannot recreate a saved file which moved or disappeared,
 * or copy an older saved version over the current one. Dirty edits remain
 * recovery drafts; a never-saved file can still keep its first local draft.
 */
export function isStaleCleanDraft(dirty: boolean, baseRevision: string | null, savedRevision: string | null | undefined): boolean {
  return !dirty && (baseRevision !== null || savedRevision != null) && savedRevision !== baseRevision;
}
