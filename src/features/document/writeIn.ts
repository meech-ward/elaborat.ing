// A note open in the workbench that takes a newer version saved elsewhere,
// such as an agent adding a section with append_to_note, writes in what the
// new version added at its end: the rendered note's new blocks come in one
// after another, and the source's new lines are highlighted for a moment.
// Display only, like a drawing's draw-in (src/features/drawings/drawIn.ts).
// The editors that show it load on first use, so this module stays out of
// the workbench's first paint.

/**
 * The newer saved version a note took while open, as the workbench gives it
 * to the views: the identity it took it as (the store's docId), its text,
 * and the text the note showed before it.
 */
export type WriteIn = { documentId: number; text: string; before: string };

/**
 * Where the text `after` adds to `before` starts, when `after` is `before`
 * (whitespace at its end aside) with more text on lines after it, as
 * append_to_note saves a note: the offset of the first added character that
 * is not whitespace. Null when `after` changes anything of `before`,
 * continues its last line, or adds only whitespace.
 */
export function appendedFrom(before: string, after: string): number | null {
  const kept = before.trimEnd();
  if (!after.startsWith(kept)) return null;
  const start = after.slice(kept.length).search(/\S/);
  if (start === -1) return null;
  const from = kept.length + start;
  return kept === "" || after.slice(kept.length, from).includes("\n") ? from : null;
}
