/** Source offsets, not a second editor's history or serialized document. */
export type SourceSelection = { anchor: number; head: number };
export type RenderedPatchOptions = {
  group?: string;
  before?: SourceSelection;
  after?: SourceSelection;
};
export type SourceHistoryResult = { text: string; selection: SourceSelection };

/** A text replacement can remove paragraph boundaries, but is still one
 * typing burst. Enter/join and explicit mark commands are separate actions. */
export function isStructuralHistoryBoundary(
  beforeBlocks: number,
  afterBlocks: number,
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
