// A note open in the workbench that takes a newer version saved elsewhere,
// such as an agent adding a section with append_to_note, writes in what the
// new version added at its end, as a model streams an answer: in Rendered
// (src/preview/typeIn.ts) and Source (src/features/source/sourceTypeIn.ts)
// the added text has its place from the start, unseen, and shows a few
// characters at a time behind a caret, at the pace set here (writeInMs,
// writeInStops). Display only, like a drawing's draw-in
// (src/features/drawings/drawIn.ts). The person's caret and selection stay
// where they were, mapped through what changed (mapThroughText,
// mapThroughDoc). The editors that show it load on first use, so this module
// stays out of the workbench's first paint.

import type { Fragment, Node as PMNode } from "prosemirror-model";

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

/** The longest an addition takes to write in, and how many characters a second it starts at. */
const WRITE_IN_MAX_MS = 4000;
const WRITE_IN_PER_SECOND = 80;

/**
 * How long an addition `length` characters long takes to write in, in
 * milliseconds: about 80 characters a second for a short one, as a model
 * streams, so a line takes about a second and a short section two; faster as
 * it grows, so even the longest takes no more than 4 seconds.
 */
export function writeInMs(length: number): number {
  if (length <= 0) return 0;
  return WRITE_IN_MAX_MS * (1 - Math.exp(-length / ((WRITE_IN_PER_SECOND * WRITE_IN_MAX_MS) / 1000)));
}

/**
 * Where the writing of `text` may pause, as offsets: after each word with the
 * spaces before it (a long one every eight characters), as a model streams a
 * few characters at a time, and at the end.
 */
export function writeInStops(text: string): number[] {
  const stops: number[] = [];
  for (const word of text.matchAll(/\s*\S{1,8}/g)) stops.push(word.index + word[0].length);
  if (stops.at(-1) !== text.length) stops.push(text.length);
  return stops;
}

/**
 * Where a place goes when what was from `from` to `to` became what is from
 * `from` to `newTo`: one before the change stays, one after it moves with its
 * text, and one inside replaced text goes to the nearer end of the new text.
 * One at `from` stays before text added there, unless `down`.
 */
function throughChange(place: number, from: number, to: number, newTo: number, down = false): number {
  if (place < from || (place === from && !(down && from === to))) return place;
  if (place >= to) return place + newTo - to;
  return place - from <= to - place ? from : newTo;
}

/**
 * Where a place in a note's text (an offset in `before`) is in the newer
 * version `after`, for the person's caret and selection in Source. The one
 * stretch that changed runs from the first character that differs to the
 * last, except that whole lines added or taken out count from the start of
 * their line: a paragraph added above one that starts with the same words is
 * a paragraph added, not words, and a place at the start of the line below
 * added lines moves down with that line.
 */
export function mapThroughText(before: string, after: string): (offset: number) => number {
  if (before === after) return (offset) => offset;
  const delta = after.length - before.length;
  const shorter = Math.min(before.length, after.length);
  let same = 0;
  while (same < shorter && before.charCodeAt(same) === after.charCodeAt(same)) same++;
  const line = same === 0 ? 0 : before.lastIndexOf("\n", same - 1) + 1;
  let tail = 0;
  while (tail < shorter - line && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  // Only whole lines added (or taken out) from the start of that line on.
  const longer = delta > 0 ? after : before;
  const lines = shorter - tail === line && longer.charCodeAt(longer.length - tail - 1) === 10;
  const from = lines ? line : same;
  const to = before.length - (lines ? tail : Math.min(tail, shorter - same));
  return (offset) => throughChange(offset, from, to, to + delta, lines && delta > 0 && from < before.length);
}

type Stretch = { from: number; to: number; newTo: number };

/** Where two runs of content that begin at `at` differ, from the first different character to the last. */
function narrowed(before: Fragment, after: Fragment, at: number): Stretch | null {
  const from = before.findDiffStart(after, at);
  const end = before.findDiffEnd(after, at + before.size, at + after.size);
  if (from === null || !end) return null;
  let { a: to, b: newTo } = end;
  // Text added or taken out beside text just like it: the stretch starts at the first difference.
  if (to < from) {
    newTo += from - to;
    to = from;
  }
  if (newTo < from) {
    to += from - newTo;
    newTo = from;
  }
  return { from, to, newTo };
}

/**
 * Where two runs of blocks that begin at `at` differ: whole blocks alike at
 * either end first, then inside a block that became another of its kind.
 */
function blocksChanged(before: Fragment, after: Fragment, at: number): Stretch | null {
  const fewer = Math.min(before.childCount, after.childCount);
  let first = 0;
  let from = at;
  while (first < fewer && before.child(first).eq(after.child(first))) from += before.child(first++).nodeSize;
  let last = 0;
  let to = at + before.size;
  let newTo = at + after.size;
  while (last < fewer - first && before.child(before.childCount - 1 - last).eq(after.child(after.childCount - 1 - last))) {
    to -= before.child(before.childCount - 1 - last).nodeSize;
    newTo -= after.child(after.childCount - 1 - last).nodeSize;
    last++;
  }
  if (before.childCount - first - last === 1 && after.childCount - first - last === 1) {
    const was = before.child(first);
    const now = after.child(first);
    if (!was.isLeaf && was.sameMarkup(now))
      return was.isTextblock ? narrowed(was.content, now.content, from + 1) : blocksChanged(was.content, now.content, from + 1);
  }
  return narrowed(before.cut(from - at, to - at), after.cut(from - at, newTo - at), from);
}

/**
 * The same for the rendered note: where a position in the document `before`
 * is in the newer version `after`, for the caret and selection in the
 * frame. Whole blocks alike at either end are kept first, so a paragraph
 * added above one that starts with the same words is a paragraph added.
 */
export function mapThroughDoc(before: PMNode, after: PMNode): (pos: number) => number {
  const change = blocksChanged(before.content, after.content, 0);
  return change ? (pos) => throughChange(pos, change.from, change.to, change.newTo) : (pos) => pos;
}
