import type { FluidProjection } from "./fluidProjection";

// Commented text between the note's source and its rendered document. The
// parent works out both directions from its own projection; the frame only
// ever gets document positions, and its positions are only proposals.

type Range = { from: number; to: number };

/**
 * The rendered document's range for the source text in [from, to): from the
 * first to the last document position whose source offset falls inside it,
 * so Markdown syntax around the text (a heading's `## `, `**`) is left out.
 * Null when no rendered text comes from there (code the view shows as an
 * object, or only syntax).
 */
export function fluidRangeForSource(
  projection: Pick<FluidProjection, "mapping">,
  from: number,
  to: number,
): Range | null {
  let start = Infinity;
  let end = -Infinity;
  for (const leaf of projection.mapping.leaves) {
    if (leaf.to < from || leaf.from > to) continue;
    for (let index = 0; index < leaf.boundaries.length; index++) {
      const offset = leaf.boundaries[index];
      if (offset == null || offset < from || offset > to) continue;
      start = Math.min(start, leaf.pos + index);
      end = Math.max(end, leaf.pos + index);
    }
  }
  return start < end ? { from: start, to: end } : null;
}

/**
 * The source range for the rendered document's [from, to): from the first to
 * the last source offset of the rendered text inside it. `from = to` is a
 * caret: the source offset of the text nearest it, both ways. Null when there
 * is no rendered text there.
 */
export function sourceRangeForFluid(
  projection: Pick<FluidProjection, "mapping">,
  from: number,
  to: number,
): Range | null {
  let start = Infinity;
  let end = -Infinity;
  let nearest = { distance: Infinity, offset: -1 };
  for (const leaf of projection.mapping.leaves) {
    for (let index = 0; index < leaf.boundaries.length; index++) {
      const offset = leaf.boundaries[index];
      if (offset == null) continue;
      const position = leaf.pos + index;
      if (position >= from && position <= to) {
        start = Math.min(start, offset);
        end = Math.max(end, offset);
      }
      const distance = Math.abs(position - from);
      if (distance < nearest.distance) nearest = { distance, offset };
    }
  }
  if (from === to) {
    const caret = Number.isFinite(start) ? start : nearest.offset;
    return caret < 0 ? null : { from: caret, to: caret };
  }
  return start < end ? { from: start, to: end } : null;
}
