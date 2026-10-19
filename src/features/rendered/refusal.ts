/**
 * What the Rendered view says after "Edit not applied:" when it refuses an
 * edit: why, in plain words. The check's own message (`reason`) is for
 * debugging; RenderedEditor logs it to the console.
 */
export const REFUSAL = {
  /** The edit cannot be written into the note's Markdown so that it shows as the editor showed it. */
  unwritable:
    "This change can't be written into the note's Markdown exactly as it looks here, so it was undone. Make it in Source.",
  /** The edit touches computed output, a component, or source the view does not show. */
  protected:
    "This part of the note comes from code or isn't shown here, so it can't be changed in Rendered. Change it in Source.",
  /** The note changed (an agent's save, an edit in Source) before the edit was written. */
  stale: "The note changed while you were typing, so this change was undone. Try again.",
} as const;

/** The plain sentence for a refused edit's `reason`. */
export function refusalNotice(reason: string): string {
  if (/protected/i.test(reason)) return REFUSAL.protected;
  if (/\bstale\b|^Source rejected the rendered/i.test(reason)) return REFUSAL.stale;
  return REFUSAL.unwritable;
}
