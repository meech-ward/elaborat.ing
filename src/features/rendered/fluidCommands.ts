import { NodeSelection, Selection, type Command, type Transaction } from "prosemirror-state";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { canJoin, Mapping, ReplaceStep, Transform, type Step } from "prosemirror-transform";
import { joinTextblockBackward, joinTextblockForward } from "prosemirror-commands";
import { liftListItem } from "prosemirror-schema-list";
import { fluidSchema } from "./fluidSchema";
import { changeTo } from "./nearestForm";

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
  return liftItem(state, dispatch, view);
};

/** Backspace at an item's text joins it to the preceding item's text in one
 * step, undoing an Enter split without leaving two paragraphs in that item.
 * At the first item of a nested list it moves the item out a level, as
 * Shift+Tab does, instead of making it a second paragraph of the item above.
 * Empty items keep their separate exit behavior above. */
export const listItemBackspace: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  const { list_item, bullet_list } = fluidSchema.nodes;
  if (
    !empty ||
    $from.parent.type !== fluidSchema.nodes.paragraph ||
    !$from.parent.content.size ||
    $from.parentOffset !== 0 ||
    $from.depth < 3 ||
    $from.node(-1).type !== list_item ||
    $from.index(-1) !== 0
  )
    return false;
  if ($from.index(-2) > 0) return joinTextblockBackward(state, dispatch, view);
  // Bullet lists only: the source cannot yet write an ordered item moved
  // out this way, so those keep the standard Backspace.
  return $from.depth >= 4 &&
    $from.node(-3).type === list_item &&
    $from.node(-2).type === bullet_list &&
    $from.node(-4).type === bullet_list
    ? liftItem(state, dispatch, view)
    : false;
};

/** Delete at the end of an item's text joins the text after it (the next
 * item's, or its nested list's first) in one step, as Backspace at the start
 * of that text does, instead of joining two items into one item with two
 * paragraphs. In an empty item it joins the next item's text into it. */
export const listItemDelete: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (
    !empty ||
    $from.parent.type !== fluidSchema.nodes.paragraph ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.depth < 2 ||
    $from.node(-1).type !== fluidSchema.nodes.list_item
  )
    return false;
  return joinTextblockForward(state, dispatch, view);
};

const isList = (node: PMNode | null | undefined) =>
  node?.type === fluidSchema.nodes.bullet_list || node?.type === fluidSchema.nodes.ordered_list;

/**
 * Shift+Tab: the list item around the selection moves out a level
 * (liftListItem). Out of its list, its own nested list and the items after
 * it would be two lists of one kind side by side, which Markdown reads back
 * as one list: they are joined into that one list. The parent checks each
 * step of an edit on its own, and a lift's first steps can pass through
 * documents it cannot write (such lists side by side, or an item wrapped
 * for a moment), so a lift of more than one step is sent as one step, from
 * the document before it to the one after.
 */
export const liftItem: Command = (state, dispatch) => {
  const item = fluidSchema.nodes.list_item;
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (node) => node.childCount > 0 && node.firstChild!.type === item);
  let lifted: Transaction | undefined;
  if (!range || !liftListItem(item)(state, (tr) => (lifted = tr)) || !lifted) return false;
  if (!dispatch) return true;
  const tr: Transaction = lifted;
  // Out of the list, the items after the lifted one stay in a copy of it,
  // which opens just before where the lifted items ended.
  if ($from.node(range.depth - 1).type !== item && range.endIndex < range.parent.childCount) {
    const $after = tr.doc.resolve(tr.mapping.map(range.end, -1) - 1);
    if (isList($after.nodeBefore) && $after.nodeAfter?.type === $after.nodeBefore!.type && canJoin(tr.doc, $after.pos))
      tr.join($after.pos);
  }
  if (tr.steps.length === 1) {
    dispatch(tr);
    return true;
  }
  const merged = state.tr;
  for (const step of changeTo(state.doc, tr.doc).steps) merged.step(step);
  // The documents are the same, so the caret is at the same place.
  dispatch(merged.setSelection(tr.selection.map(merged.doc, new Mapping())).scrollIntoView());
  return true;
};

/** Mod-Enter in a task item ticks or unticks its box, as Notion's shortcut
 * does, with the edit a click on the box makes. */
export const toggleTask: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type !== fluidSchema.nodes.list_item) continue;
    if (node.attrs.checked === null) return false;
    dispatch?.(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }));
    return true;
  }
  return false;
};

/**
 * Shift+Enter: a line break in a paragraph, with no formatting (Markdown
 * writes a break with none), in place of the selection and of the spaces
 * after it, which Markdown cannot write at the start of a line. A heading
 * has no line breaks in Markdown, so there the key does nothing.
 */
export const hardBreak: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  // A selected island stays: a break in its place would replace it.
  if (state.selection instanceof NodeSelection) return true;
  if ($from.parent.type !== fluidSchema.nodes.paragraph || !$from.sameParent($to)) return true;
  const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, "\n");
  const spaces = /^[ \t]*/.exec(after)![0].length;
  dispatch?.(
    state.tr
      .replaceWith($from.pos, $to.pos + spaces, fluidSchema.nodes.hard_break.create())
      .scrollIntoView(),
  );
  return true;
};

/**
 * Where an edit put a line break that ends its paragraph (Shift+Enter at the
 * end of a line), or null. Markdown cannot write a break there, so the editor
 * shows it but holds it back until text follows (fluidEditor.ts).
 */
export function trailingBreak(steps: readonly Step[], doc: PMNode): ReplaceStep | null {
  const [step] = steps;
  if (steps.length !== 1 || !(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return null;
  if (step.slice.content.lastChild?.type !== fluidSchema.nodes.hard_break) return null;
  const $end = doc.resolve(step.from + step.slice.size);
  return $end.parent.type === fluidSchema.nodes.paragraph && $end.parentOffset === $end.parent.content.size ? step : null;
}

/**
 * An edit that leaves a line break ending its paragraph without putting it
 * there, as taking out the text typed after a break does. Markdown cannot
 * write that break, so the parent gets the edit with the break taken out
 * too (`steps`, one step making `base`), and the editor holds the break
 * (`hold`, the step that puts it back on `base`) as if it was just typed.
 * Null for any other edit.
 */
export function leftBreak(before: PMNode, after: PMNode): { steps: Step[]; base: PMNode; hold: ReplaceStep } | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return null;
  const end = before.content.findDiffEnd(after.content)!.b;
  const breaks: number[] = [];
  after.nodesBetween(Math.min(start, end), Math.max(start, end), (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.lastChild?.type === fluidSchema.nodes.hard_break) breaks.push(pos + node.nodeSize - 2);
    return false;
  });
  if (breaks.length !== 1) return null;
  const [at] = breaks;
  const base = new Transform(after).delete(at, at + 1).doc;
  return {
    steps: changeTo(before, base).steps,
    base,
    hold: new ReplaceStep(at, at, new Slice(Fragment.from(fluidSchema.nodes.hard_break.create()), 0, 0)),
  };
}

/**
 * An edit made just after a held line break (`held`, the step that made it),
 * with it, as one step: another break, which is held too, or text, which
 * Markdown can write after the break. "spaces" for spaces alone, which
 * Markdown cannot write at the start of a line. Null for any other edit.
 */
export function afterHeldBreak(held: ReplaceStep, steps: readonly Step[]): ReplaceStep | "spaces" | null {
  const [step] = steps;
  const end = held.from + held.slice.size;
  if (steps.length !== 1 || !(step instanceof ReplaceStep) || step.from !== end || step.to !== end) return null;
  if (step.slice.openStart || step.slice.openEnd || !step.slice.size) return null;
  let inline = true;
  step.slice.content.forEach((node) => {
    inline &&= node.isInline;
  });
  if (!inline) return null;
  const text = step.slice.content.textBetween(0, step.slice.content.size, undefined, "\n");
  if (/^[ \t]+$/.test(text)) return "spaces";
  const merged = held.merge(step);
  return merged instanceof ReplaceStep ? merged : null;
}

/** Two edits made one after the other, such as letters typed or deleted in
 * a row, as one step (ReplaceStep.merge); null when they are not one. */
export function typedTogether(first: readonly Step[], next: readonly Step[]): Step | null {
  return first.length === 1 && next.length === 1 && first[0] instanceof ReplaceStep && next[0] instanceof ReplaceStep
    ? first[0].merge(next[0])
    : null;
}

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
