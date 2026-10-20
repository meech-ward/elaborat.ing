import { Selection, type Command, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { joinTextblockBackward } from "prosemirror-commands";
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

/** Backspace removes an empty middle item, returning to the previous textblock.
 * Lifting it would split its list around an empty paragraph, which Markdown
 * cannot hold. At the list's edges, keep the usual lift out of the list.
 * Other selections stay on the native Backspace chain. */
export const emptyListBackspace: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.type !== fluidSchema.nodes.paragraph) return false;
  if ($from.parent.content.size !== 0) return false;
  if ($from.depth < 1) return false;
  if ($from.node($from.depth - 1).type !== fluidSchema.nodes.list_item)
    return false;
  const itemDepth = $from.depth - 1;
  const listDepth = itemDepth - 1;
  const item = $from.node(itemDepth);
  const index = $from.index(listDepth);
  if (
    item.childCount === 1 &&
    index > 0 &&
    index < $from.node(listDepth).childCount - 1
  ) {
    if (joinTextblockBackward(state, dispatch, view)) return true;
    // An isolated block at the end of the previous item stops the standard
    // join. Delete only this proven empty item, preserving that block.
    if (dispatch) {
      const from = $from.before(itemDepth);
      const tr = state.tr.delete(from, $from.after(itemDepth));
      const before = tr.doc.resolve(from);
      dispatch(
        tr.setSelection(
          Selection.findFrom(before, -1, true) ?? Selection.near(before, -1),
        ).scrollIntoView(),
      );
    }
    return true;
  }
  return liftListItem(fluidSchema.nodes.list_item)(state, dispatch, view);
};

/** Backspace at an item's text joins it to the preceding item's text in one
 * step, undoing an Enter split without leaving two paragraphs in that item.
 * Empty items keep their separate exit behavior above. */
export const listItemBackspace: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (
    !empty ||
    $from.parent.type !== fluidSchema.nodes.paragraph ||
    !$from.parent.content.size ||
    $from.parentOffset !== 0 ||
    $from.depth < 3 ||
    $from.node(-1).type !== fluidSchema.nodes.list_item ||
    $from.index(-1) !== 0 ||
    $from.index(-2) === 0
  )
    return false;
  return joinTextblockBackward(state, dispatch, view);
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

/**
 * Whether Markdown can write the empty paragraphs between a note's blocks:
 * blank lines make one at most between two blocks or before the first, and
 * two at the end of the note (`blankParagraphPatch` in fluidProjection.ts).
 */
export function holdsEmptyParagraphs(doc: PMNode): boolean {
  let run = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    if (block.type === fluidSchema.nodes.paragraph && !block.content.size) {
      run++;
      continue;
    }
    if (run > 1) return false;
    run = 0;
  }
  return run <= (run === doc.childCount ? 1 : 2);
}

/**
 * `command`, except where its change would leave empty paragraphs side by
 * side that Markdown cannot write (`holdsEmptyParagraphs`), such as Enter on
 * an empty line Enter made between two blocks: there it does nothing, and the
 * caret stays where it is, instead of an edit that would be refused.
 */
export function keepingEmptyParagraphs(command: Command): Command {
  return (state, dispatch, view) => {
    let made: Transaction | undefined;
    if (!command(state, dispatch && ((tr) => (made = tr)), view)) return false;
    if (made && dispatch && (holdsEmptyParagraphs(made.doc) || !holdsEmptyParagraphs(state.doc))) dispatch(made);
    return true;
  };
}
