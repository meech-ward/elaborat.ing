import { describe, expect, test } from "bun:test";
import { applySourcePatches, type SourcePatch } from "../document";
import {
  acceptReviewSuggestion, applyReviewPatches, createReview, proposedSource,
  rejectReviewSuggestion, replaceReviewSource, validateReview, type ReviewState,
} from "./review";

function ids() { let id = 0; return () => `suggestion-${++id}`; }
function edit(state: ReviewState, from: number, to: number, insert: string, idFactory = ids()) {
  return applyReviewPatches(state, [{ from, to, insert, expected: proposedSource(state).slice(from, to) }], idFactory);
}

describe("local source suggestions", () => {
  test("typing changes proposed source while preserving accepted source and surrounding MDX", () => {
    const base = "import { Card } from 'workspace:card.mdx'\r\n\r\nHello.\r\n\r\n<Card value={answer} />";
    const from = base.indexOf("Hello");
    const state = edit(createReview(base), from, from + 5, "Welcome");
    expect(state.base).toBe(base);
    expect(state.suggestions).toEqual([{ id: "suggestion-1", from, to: from + 5, expected: "Hello", insert: "Welcome" }]);
    expect(proposedSource(state)).toBe(base.replace("Hello", "Welcome"));
  });

  test("separate edits stay independent and accepting one preserves the other proposed change", () => {
    const idFactory = ids();
    let state = edit(createReview("One.\r\n\r\nTwo."), 0, 3, "First", idFactory);
    state = edit(state, proposedSource(state).indexOf("Two"), proposedSource(state).indexOf("Two") + 3, "Second", idFactory);
    expect(state.suggestions).toHaveLength(2);
    const source = proposedSource(state);
    const second = state.suggestions[1];
    const accepted = acceptReviewSuggestion(state, state.suggestions[0].id);
    expect(accepted.base).toBe("First.\r\n\r\nTwo.");
    expect(accepted.suggestions[0]).toEqual({ ...second, from: second.from + 2, to: second.to + 2 });
    expect(proposedSource(accepted)).toBe(source);
    expect(rejectReviewSuggestion(accepted, second.id)).toEqual(createReview(accepted.base));
  });

  test("continued and adjacent typing keep a stable suggestion ID", () => {
    const idFactory = ids();
    let state = edit(createReview("Hello world"), 5, 5, ",", idFactory);
    const id = state.suggestions[0].id;
    state = edit(state, 6, 6, " dear", idFactory);
    state = edit(state, 8, 10, "EA", idFactory);
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0].id).toBe(id);
    expect(proposedSource(state)).toBe("Hello, dEAr world");
    state = replaceReviewSource(state, "Hello world", idFactory);
    expect(state).toEqual(createReview("Hello world"));
  });

  test("deletion followed by typing at its boundary becomes one replacement", () => {
    let state = edit(createReview("Hello world"), 6, 11, "");
    const id = state.suggestions[0].id;
    state = edit(state, 6, 6, "friend");
    expect(state.suggestions).toEqual([{ id, from: 6, to: 10, expected: "worl", insert: "frien" }]);
    expect(proposedSource(state)).toBe("Hello friend");
  });

  test("an edit spanning local changes merges them without rewriting accepted source", () => {
    const idFactory = ids();
    let state = edit(createReview("alpha middle omega"), 0, 5, "A", idFactory);
    state = edit(state, 9, 14, "Z", idFactory);
    const first = state.suggestions[0].id;
    expect(proposedSource(state)).toBe("A middle Z");
    state = edit(state, 0, 10, "All", idFactory);
    expect(state.suggestions).toEqual([{ id: first, from: 0, to: 18, expected: "alpha middle omega", insert: "All" }]);
    expect(state.base).toBe("alpha middle omega");
  });

  test("restoring original text cancels replacement and deletion proposals", () => {
    const base = "one two three";
    let state = edit(createReview(base), 4, 7, "TWO");
    state = edit(state, 4, 7, "two");
    expect(state.suggestions).toEqual([]);
    state = edit(state, 4, 7, "");
    state = edit(state, 4, 4, "two");
    expect(state.suggestions).toEqual([]);
  });

  test("repeated words use supplied edit offsets without attaching to the wrong occurrence", () => {
    let state = edit(createReview("same same same"), 5, 9, "changed");
    expect(state.suggestions[0]).toMatchObject({ from: 5, to: 9, expected: "same", insert: "changed" });
    state = edit(state, 6, 7, "H");
    expect(state.suggestions[0]).toMatchObject({ from: 5, to: 9, expected: "same", insert: "cHanged" });
    expect(rejectReviewSuggestion(state, state.suggestions[0].id).base).toBe("same same same");
  });

  test("whole-string changes preserve separated proposals and undo/redo source", () => {
    const idFactory = ids();
    const initial = createReview("a middle z");
    const changed = replaceReviewSource(initial, "A middle Z", idFactory);
    expect(changed.suggestions).toHaveLength(2);
    expect(proposedSource(changed)).toBe("A middle Z");
    const undone = replaceReviewSource(changed, initial.base, idFactory);
    expect(undone.suggestions).toEqual([]);
    const redone = replaceReviewSource(undone, "A middle Z", idFactory);
    expect(proposedSource(redone)).toBe("A middle Z");
  });

  test("batched multi-cursor edits are atomic and stable at shared insertion positions", () => {
    const state = createReview("abcd");
    const changes = applyReviewPatches(state, [
      { from: 0, to: 1, expected: "a", insert: "A" },
      { from: 4, to: 4, expected: "", insert: "1" },
      { from: 4, to: 4, expected: "", insert: "2" },
    ], ids());
    expect(proposedSource(changes)).toBe("Abcd12");
    expect(changes.suggestions).toHaveLength(2);
    expect(state).toEqual(createReview("abcd"));
  });

  test("emoji replacements retain full code points when their surrogate prefixes match", () => {
    const state = replaceReviewSource(createReview("A😀 B😀"), "A😁 B😃", ids());
    expect(state.suggestions).toHaveLength(2);
    expect(state.suggestions.map(suggestion => suggestion.expected)).toEqual(["😀", "😀"]);
    expect(state.suggestions.map(suggestion => suggestion.insert)).toEqual(["😁", "😃"]);
    expect(proposedSource(state)).toBe("A😁 B😃");
    expect(acceptReviewSuggestion(state, state.suggestions[1].id).base).toBe("A😀 B😃");
  });

  test("malformed or stale patches fail without changing the review", () => {
    const state = edit(createReview("a😀bc"), 4, 5, "C");
    const before = structuredClone(state);
    const malformed: SourcePatch[][] = [
      [{ from: 2, to: 3, expected: "\ude00", insert: "x" }],
      [{ from: 0, to: 1, expected: "wrong", insert: "x" }],
      [{ from: -1, to: 0, expected: "", insert: "x" }],
      [{ from: 0, to: 100, expected: "", insert: "x" }],
      [{ from: 0, to: 3, expected: "a😀", insert: "x" }, { from: 1, to: 4, expected: "😀b", insert: "y" }],
    ];
    for (const patches of malformed) expect(() => applyReviewPatches(state, patches)).toThrow();
    expect(state).toEqual(before);
  });

  test("invalid persisted states and stale review actions are refused", () => {
    const suggestion = { id: "one", from: 0, to: 1, expected: "a", insert: "A" };
    expect(() => validateReview({ base: "ab", suggestions: [suggestion, { ...suggestion, id: "two", from: 1, to: 2, expected: "b" }] })).toThrow(/separate/);
    expect(() => validateReview({ base: "ab", suggestions: [suggestion, { ...suggestion, from: 2, to: 2, expected: "" }] })).toThrow(/unique/);
    expect(() => validateReview({ base: "ab", suggestions: [{ ...suggestion, expected: "wrong" }] })).toThrow(/mismatch/);
    expect(() => acceptReviewSuggestion(createReview("ab"), "gone")).toThrow(/no longer/);
    expect(() => rejectReviewSuggestion(createReview("ab"), "gone")).toThrow(/no longer/);
  });

  test("large source rewrites use a bounded exact replacement", () => {
    const base = "a".repeat(1200);
    const next = "b".repeat(1200);
    const state = replaceReviewSource(createReview(base), next);
    expect(state.suggestions).toHaveLength(1);
    expect(proposedSource(state)).toBe(next);
    expect(acceptReviewSuggestion(state, state.suggestions[0].id)).toEqual(createReview(next));
  });

  test("mixed local operations preserve the exact source and accept/reject invariants", () => {
    let seed = 17;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    const idFactory = ids();
    let state = createReview("alpha\r\nbeta gamma\n");
    for (let index = 0; index < 150; index++) {
      const source = proposedSource(state);
      const from = random(source.length + 1);
      const to = from + random(source.length - from + 1);
      const insert = ["", "x", "Word", "\r\n", "<Card />"][random(5)];
      const patch = { from, to, insert, expected: source.slice(from, to) };
      const expected = applySourcePatches({ text: source, revision: 0, format: "mdx" }, 0, [patch]).text;
      state = applyReviewPatches(state, [patch], idFactory);
      expect(proposedSource(state)).toBe(expected);
      if (state.suggestions.length && index % 3 === 0) {
        const chosen = state.suggestions[random(state.suggestions.length)];
        state = acceptReviewSuggestion(state, chosen.id);
        expect(proposedSource(state)).toBe(expected);
      }
      if (state.suggestions.length && index % 7 === 0) state = rejectReviewSuggestion(state, state.suggestions[0].id);
      validateReview(state);
    }
  });
});
