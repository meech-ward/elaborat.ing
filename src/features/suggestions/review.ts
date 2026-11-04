import { applySourcePatches, type SourcePatch } from "../document";

/** Local proposals use offsets in `base`; editor patches use proposed-source offsets. */
export type ReviewSuggestion = SourcePatch & { id: string };
export type ReviewState = { base: string; suggestions: ReviewSuggestion[] };

type PlacedSuggestion = ReviewSuggestion & { start: number; end: number };
type IdFactory = () => string;

const newId: IdFactory = () => crypto.randomUUID();

function splitsPair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1), after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function checkBoundaries(text: string, from: number, to: number): void {
  if (splitsPair(text, from) || splitsPair(text, to))
    throw new Error("A suggestion cannot split a Unicode character.");
}

/** Validate restored sidecars with the same exact checks as live editing. */
export function validateReview(state: ReviewState): void {
  if (!state || typeof state.base !== "string" || !Array.isArray(state.suggestions))
    throw new Error("Invalid review state.");
  const ids = new Set<string>();
  let previous: ReviewSuggestion | undefined;
  for (const suggestion of state.suggestions) {
    if (!suggestion || typeof suggestion.id !== "string" || suggestion.id.length === 0 || ids.has(suggestion.id))
      throw new Error("Suggestions need unique, nonempty IDs.");
    ids.add(suggestion.id);
    if (previous && suggestion.from <= previous.to)
      throw new Error("Suggestions must be ordered, separate source ranges.");
    if (suggestion.insert === suggestion.expected)
      throw new Error("A suggestion must change its original text.");
    checkBoundaries(state.base, suggestion.from, suggestion.to);
    previous = suggestion;
  }
  applySourcePatches({ text: state.base, format: "mdx", revision: 0 }, 0, state.suggestions);
}

export function createReview(base: string): ReviewState {
  const state = { base, suggestions: [] };
  validateReview(state);
  return state;
}

export function proposedSource(state: ReviewState): string {
  validateReview(state);
  return applySourcePatches({ text: state.base, format: "mdx", revision: 0 }, 0, state.suggestions).text;
}

function placed(state: ReviewState): PlacedSuggestion[] {
  let shift = 0;
  return state.suggestions.map(suggestion => {
    const start = suggestion.from + shift;
    shift += suggestion.insert.length - (suggestion.to - suggestion.from);
    return { ...suggestion, start, end: start + suggestion.insert.length };
  });
}

/** An offset outside proposal-owned text maps exactly to accepted source. */
function baseOffset(suggestions: readonly PlacedSuggestion[], offset: number): number {
  let shift = 0;
  for (const suggestion of suggestions) {
    if (offset < suggestion.start) break;
    if (offset <= suggestion.end) {
      if (offset === suggestion.start) return suggestion.from;
      if (offset === suggestion.end) return suggestion.to;
      throw new Error("Cannot map an offset inside a pending insertion.");
    }
    shift += suggestion.insert.length - (suggestion.to - suggestion.from);
  }
  return offset - shift;
}

/** Keep exact unchanged edges out of a proposal, including complete surrogate pairs. */
function trimmed(base: string, from: number, to: number, insert: string): SourcePatch | null {
  const expected = base.slice(from, to);
  let start = 0, oldEnd = expected.length, newEnd = insert.length;
  while (start < oldEnd && start < newEnd && expected[start] === insert[start]) start++;
  while (splitsPair(expected, start) || splitsPair(insert, start)) start--;
  while (oldEnd > start && newEnd > start && expected[oldEnd - 1] === insert[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  while (splitsPair(expected, oldEnd) || splitsPair(insert, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  if (start === oldEnd && start === newEnd) return null;
  return { from: from + start, to: from + oldEnd, insert: insert.slice(start, newEnd), expected: expected.slice(start, oldEnd) };
}

function applyOne(state: ReviewState, patch: SourcePatch, idFactory: IdFactory): ReviewState {
  if (patch.insert === patch.expected) return state;
  const source = proposedSource(state);
  const positions = placed(state);
  // A zero-width deletion also owns its boundary. Typing there revises that
  // deletion into a replacement instead of producing two competing hunks.
  const touched = positions.filter(suggestion => suggestion.start <= patch.to && suggestion.end >= patch.from);
  const start = Math.min(patch.from, ...touched.map(suggestion => suggestion.start));
  const end = Math.max(patch.to, ...touched.map(suggestion => suggestion.end));
  const from = touched.length && start === touched[0].start ? touched[0].from : baseOffset(positions, start);
  const last = touched.at(-1);
  const to = last && end === last.end ? last.to : baseOffset(positions, end);
  const insert = source.slice(start, patch.from) + patch.insert + source.slice(patch.to, end);
  const proposal = trimmed(state.base, from, to, insert);
  const touchedIds = new Set(touched.map(suggestion => suggestion.id));
  const suggestions = state.suggestions.filter(suggestion => !touchedIds.has(suggestion.id));
  if (proposal) suggestions.push({ ...proposal, id: touched[0]?.id ?? idFactory() });
  suggestions.sort((a, b) => a.from - b.from || a.to - b.to);
  const next = { base: state.base, suggestions };
  validateReview(next);
  return next;
}

/** All patches target the same proposed snapshot and succeed or fail together. */
export function applyReviewPatches(state: ReviewState, patches: SourcePatch[], idFactory: IdFactory = newId): ReviewState {
  const source = proposedSource(state);
  const expected = applySourcePatches({ text: source, format: "mdx", revision: 0 }, 0, patches).text;
  for (const patch of patches) checkBoundaries(source, patch.from, patch.to);
  if (expected === source) return state;
  let next = state;
  // Reverse source order also preserves the checked applier's stable order
  // when a transaction inserts more than once at the same offset.
  for (const patch of [...patches].sort((a, b) => a.from - b.from || a.to - b.to).reverse())
    next = applyOne(next, patch, idFactory);
  if (proposedSource(next) !== expected) throw new Error("Review composition did not preserve the proposed source.");
  return next;
}

/**
 * Monaco currently reports a complete string, including undo/redo. A bounded
 * LCS preserves separate edits for normal transactions. Large whole-source
 * rewrites remain one exact proposal instead of spending quadratic time.
 * Ambiguous repeated text has no edit provenance in this API.
 */
function replacementPatches(before: string, after: string): SourcePatch[] {
  const outer = trimmed(before, 0, before.length, after);
  if (!outer) return [];
  if (!outer.expected || !outer.insert || outer.expected.length * outer.insert.length > 1_000_000) return [outer];
  const old = Array.from(outer.expected), next = Array.from(outer.insert);
  if ((old.length + 1) * (next.length + 1) > 250_000) return [outer];
  const width = next.length + 1;
  const table = new Uint32Array((old.length + 1) * width);
  for (let a = old.length - 1; a >= 0; a--)
    for (let b = next.length - 1; b >= 0; b--)
      table[a * width + b] = old[a] === next[b] ? 1 + table[(a + 1) * width + b + 1] : Math.max(table[(a + 1) * width + b], table[a * width + b + 1]);
  const patches: SourcePatch[] = [];
  let a = 0, b = 0, offset = outer.from, active: SourcePatch | null = null;
  const flush = () => { if (active) patches.push(active); active = null; };
  while (a < old.length || b < next.length) {
    if (a < old.length && b < next.length && old[a] === next[b]) {
      flush();
      offset += old[a].length;
      a++; b++;
    } else {
      active ??= { from: offset, to: offset, expected: "", insert: "" };
      if (a < old.length && (b === next.length || table[(a + 1) * width + b] >= table[a * width + b + 1])) {
        active.expected += old[a];
        offset += old[a].length;
        active.to = offset;
        a++;
      } else {
        active.insert += next[b++];
      }
    }
  }
  flush();
  return patches;
}

export function replaceReviewSource(state: ReviewState, next: string, idFactory: IdFactory = newId): ReviewState {
  if (typeof next !== "string") throw new Error("Proposed source must be text.");
  return applyReviewPatches(state, replacementPatches(proposedSource(state), next), idFactory);
}

function findSuggestion(state: ReviewState, id: string): ReviewSuggestion {
  validateReview(state);
  const suggestion = state.suggestions.find(suggestion => suggestion.id === id);
  if (!suggestion) throw new Error("This suggestion is no longer pending.");
  return suggestion;
}

export function rejectReviewSuggestion(state: ReviewState, id: string): ReviewState {
  findSuggestion(state, id);
  return { base: state.base, suggestions: state.suggestions.filter(suggestion => suggestion.id !== id) };
}

export function acceptReviewSuggestion(state: ReviewState, id: string): ReviewState {
  const accepted = findSuggestion(state, id);
  const base = applySourcePatches({ text: state.base, format: "mdx", revision: 0 }, 0, [accepted]).text;
  const shift = accepted.insert.length - (accepted.to - accepted.from);
  const suggestions = state.suggestions.filter(suggestion => suggestion.id !== id).map(suggestion => suggestion.from >= accepted.to
    ? { ...suggestion, from: suggestion.from + shift, to: suggestion.to + shift }
    : suggestion);
  const next = { base, suggestions };
  validateReview(next);
  return next;
}
