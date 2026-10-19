import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { liftListItem } from "prosemirror-schema-list";
import { fluidSchema } from "./fluidSchema";

/**
 * A paragraph that is only a code fence's opening line, as typed: three or
 * more backticks and an optional language, in plain text. Enter turns it into
 * a code block (fluidEditor.ts asks, `codeFenceFromParagraph` makes it).
 */
export function codeFenceOpener(
  paragraph: PMNode,
): { ticks: string; info: string } | null {
  if (paragraph.type !== fluidSchema.nodes.paragraph) return null;
  let plain = true;
  paragraph.forEach((child) => {
    if (!child.isText || child.marks.length) plain = false;
  });
  const match = plain ? /^(`{3,})([^`]*)$/.exec(paragraph.textContent) : null;
  return match ? { ticks: match[1], info: match[2].trim() } : null;
}

/** Backspace out of an empty list item via lift (list(2)+paragraph).
 * Returns false for every other selection so the native Backspace chain
 * (deleteSelection/joinBackward) still handles it. */
export const emptyListBackspace: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.type !== fluidSchema.nodes.paragraph) return false;
  if ($from.parent.content.size !== 0) return false;
  if ($from.depth < 1) return false;
  if ($from.node($from.depth - 1).type !== fluidSchema.nodes.list_item)
    return false;
  return liftListItem(fluidSchema.nodes.list_item)(state, dispatch, view);
};

/**
 * Enter at the start of a line in a quote. Markdown has no empty paragraph
 * inside a quote, so the empty paragraph goes just outside it, above that
 * line: above the quote at its first line, as Enter at the start of a
 * heading puts one above the heading, or at a later line between the two
 * quotes it splits into there. The caret stays at the start of the line.
 */
export const quoteStartEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (
    !empty ||
    $from.depth !== 2 ||
    $from.parentOffset !== 0 ||
    $from.parent.type !== fluidSchema.nodes.paragraph ||
    !$from.parent.content.size ||
    $from.node(1).type !== fluidSchema.nodes.blockquote
  )
    return false;
  if (dispatch) {
    const tr = state.tr;
    const paragraph = fluidSchema.nodes.paragraph.create();
    if ($from.index(1) === 0) tr.insert($from.before(1), paragraph);
    else tr.split($from.before()).insert($from.before() + 1, paragraph);
    dispatch(tr.scrollIntoView());
  }
  return true;
};
