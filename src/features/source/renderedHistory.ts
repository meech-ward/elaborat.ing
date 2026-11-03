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

/** The blocks of a rendered document, in a form two can be compared by: how
 * many there are at the top, and of each kind at any depth (paragraphs and
 * list items in lists, too). */
export function blockShape(doc: PMNode): string {
  const counts = new Map<string, number>();
  const count = (node: PMNode) =>
    node.forEach((child) => {
      if (child.isInline) return;
      counts.set(child.type.name, (counts.get(child.type.name) ?? 0) + 1);
      if (!child.isTextblock) count(child);
    });
  count(doc);
  return [doc.childCount, ...[...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, n]) => `${name}:${n}`)].join(" ");
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
