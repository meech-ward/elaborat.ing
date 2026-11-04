import { expect, test } from "bun:test";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { baseKeymap } from "prosemirror-commands";
import { splitListItem } from "prosemirror-schema-list";
import { blockShape, isStructuralHistoryBoundary } from "../source/renderedHistory";
import { liftItem, listItemBackspace, listItemDelete } from "./fluidCommands";
import { fluidPositionForSourceOffset, projectFluidSource } from "./fluidProjection";
import { fluidSchema } from "./fluidSchema";

test("cross-paragraph replacement starts one typing undo group, while split/join remains separate", () => {
  expect(
    isStructuralHistoryBoundary("2", "1", [
      { stepType: "replace", slice: { content: [{ text: "J" }] } },
    ]),
  ).toBe(false);
  expect(
    isStructuralHistoryBoundary("2", "2", [
      { stepType: "replace", slice: { content: [{ text: "O" }] } },
    ]),
  ).toBe(false);
  expect(
    isStructuralHistoryBoundary("1", "2", [
      { stepType: "replace", slice: { content: [{}, {}] } },
    ]),
  ).toBe(true);
  expect(isStructuralHistoryBoundary("2", "1", [{ stepType: "replace" }])).toBe(
    true,
  );
});

/** Whether `command`, at the end of `word` in `text` (or `offset` into it), is an undo group of its own. */
async function boundary(text: string, word: string, command: Command, offset = word.length) {
  const projection = await projectFluidSource(text, "md");
  const at = fluidPositionForSourceOffset(projection, text.indexOf(word) + offset)!;
  const state = EditorState.create({ doc: projection.doc, selection: TextSelection.create(projection.doc, at) });
  let made: Transaction | undefined;
  expect(command(state, (tr) => (made = tr))).toBe(true);
  return isStructuralHistoryBoundary(
    blockShape(state.doc),
    blockShape(made!.doc),
    made!.steps.map((step) => step.toJSON()),
  );
}

test("Enter, Backspace and Delete that split or join list items are undone on their own, as in a paragraph", async () => {
  const item = splitListItem(fluidSchema.nodes.list_item);
  expect(await boundary("- alpha\n- bravo\n- charlie", "bravo", item)).toBe(true);
  expect(await boundary("- alpha\n- bravo\n- charlie", "bravo", listItemBackspace, 0)).toBe(true);
  expect(await boundary("- alpha\n- bravo\n- charlie", "alpha", listItemDelete)).toBe(true);
  expect(await boundary("> - alpha\n> - bravo", "alpha", item)).toBe(true);
  // A paragraph's Enter and join, as before.
  expect(await boundary("Alpha.\n\nBravo.", "Alpha.", baseKeymap.Enter)).toBe(true);
  expect(await boundary("Alpha.\n\nBravo.", "Bravo.", baseKeymap.Backspace, 0)).toBe(true);
  // Typing and deleting a letter stay in the typing group.
  const typed: Command = (state, dispatch) => (dispatch?.(state.tr.insertText("x")), true);
  const deleted: Command = (state, dispatch) => (dispatch?.(state.tr.delete(state.selection.from - 1, state.selection.from)), true);
  expect(await boundary("- alpha\n- bravo", "bravo", typed)).toBe(false);
  expect(await boundary("- alpha\n- bravo", "bravo", deleted)).toBe(false);
  // A lift is one too, also one that keeps as many blocks of each kind:
  // Shift+Tab, or Backspace, on a nested list's first item with items after it.
  expect(await boundary("- a\n  - b\n  - c\n- d", "b", liftItem)).toBe(true);
  expect(await boundary("- a\n  - b\n  - c\n- d", "b", listItemBackspace, 0)).toBe(true);
  expect(await boundary("- a\n  - b\n- d", "b", liftItem)).toBe(true);
  // A line break is inline: it joins the typing around it.
  const lineBreak: Command = (state, dispatch) => (dispatch?.(state.tr.replaceSelectionWith(fluidSchema.nodes.hard_break.create(), false)), true);
  expect(await boundary("- alpha bravo", "alpha ", lineBreak)).toBe(false);
});

test("a document's block shape is its blocks and how they nest, not its text", async () => {
  const shape = async (text: string) => blockShape((await projectFluidSource(text, "md")).doc);
  expect(await shape("- a\n- b")).toBe("bullet_list(list_item(paragraph) list_item(paragraph))");
  expect(await shape("- a\n  - b")).toBe("bullet_list(list_item(paragraph bullet_list(list_item(paragraph))))");
  expect(await shape("- edited\n- b")).toBe(await shape("- a\n- b"));
  expect(await shape("# One\n\ntwo\\\nlines")).toBe("heading paragraph");
  // As many blocks of each kind, nested another way.
  expect(await shape("- a\n  - b\n  - c\n- d")).not.toBe(await shape("- a\n- b\n  - c\n- d"));
});
