import type { Node as PMNode } from "prosemirror-model";

/** Source offsets, not a second editor's history or serialized document. */
export type SourceSelection = { anchor: number; head: number };
export type RenderedPatchOptions = {
  group?: string;
  before?: SourceSelection;
  after?: SourceSelection;
};
export type SourceHistoryResult = { text: string; selection: SourceSelection };
/**
 * Where the person is in a note, carried between Source and Rendered when the
 * view switches: what they selected (a caret when anchor = head), or, with
 * nothing selected, the text at the top of the view. Source offsets.
 */
export type NotePlace = { selection: SourceSelection } | { top: number };

/** The blocks of a rendered document and how they nest, in a form two can
 * be compared by: typing never changes it, and Enter, a join or a lift
 * always does, even a lift that leaves as many blocks of each kind
 * (Shift+Tab on a nested list's first item with items after it). */
export function blockShape(doc: PMNode): string {
  const shape = (node: PMNode): string => {
    const blocks: string[] = [];
    node.forEach((child) => {
      if (child.isInline) return;
      blocks.push(child.isTextblock || child.isLeaf ? child.type.name : `${child.type.name}(${shape(child)})`);
    });
    return blocks.join(" ");
  };
  return shape(doc);
}

/** A text replacement can remove paragraph boundaries, but is still one
 * typing burst. Enter and joins (in a list too) and explicit mark commands
 * are separate actions: an edit that inserts no text and changes the
 * document's blocks (`blockShape`) is one. */
export function isStructuralHistoryBoundary(
  beforeBlocks: string,
  afterBlocks: string,
  steps: readonly {
    stepType: string;
    slice?: { content?: readonly { text?: string }[] };
  }[],
): boolean {
  const insertsText = steps.some((step) =>
    step.slice?.content?.some((node) => Boolean(node.text)),
  );
  return (
    (!insertsText && beforeBlocks !== afterBlocks) ||
    steps.some((step) => step.stepType !== "replace")
  );
}
