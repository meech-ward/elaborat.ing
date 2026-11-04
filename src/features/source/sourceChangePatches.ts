import { applySourcePatches, type SourcePatch } from "../document";

/** The model reports offsets before its changes, excluding its separately held BOM. */
type ModelContentEvent = {
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[];
  isFlush?: boolean;
  isEolChange?: boolean;
};

function splitsPair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1), after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Preserve a source editor transaction's actual replacement ranges. Resets
 * and line-ending conversions do not have ordinary old-model edit ranges;
 * callers retain the full new text and use their whole-source fallback.
 * `previousBomLength` comes from the old model, not a guessed leading mark:
 * a BOM typed into its content is distinct from the model's metadata BOM.
 */
export function sourceChangePatches(
  before: string,
  after: string,
  previousBomLength: number,
  event: ModelContentEvent,
): SourcePatch[] | undefined {
  if (event.isFlush || event.isEolChange || ![0, 1].includes(previousBomLength) ||
      (previousBomLength === 1 && !before.startsWith("\ufeff"))) return undefined;
  const patches: SourcePatch[] = [];
  for (const change of event.changes) {
    if (!Number.isInteger(change.rangeOffset) || !Number.isInteger(change.rangeLength) ||
        change.rangeOffset < 0 || change.rangeLength < 0 || typeof change.text !== "string") return undefined;
    const from = change.rangeOffset + previousBomLength;
    const to = from + change.rangeLength;
    if (to > before.length || splitsPair(before, from) || splitsPair(before, to)) return undefined;
    patches.push({ from, to, insert: change.text, expected: before.slice(from, to) });
  }
  try {
    return applySourcePatches({ text: before, format: "mdx", revision: 0 }, 0, patches).text === after ? patches : undefined;
  } catch {
    return undefined;
  }
}
