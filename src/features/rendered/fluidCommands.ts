import type { Command } from "prosemirror-state";
import { liftListItem } from "prosemirror-schema-list";
import { fluidSchema } from "./fluidSchema";

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
