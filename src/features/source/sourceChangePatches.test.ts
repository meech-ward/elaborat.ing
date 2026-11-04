import { describe, expect, test } from "bun:test";
import { applySourcePatches } from "../document";
import { applyReviewPatches, createReview, proposedSource } from "../suggestions/review";
import { sourceChangePatches } from "./sourceChangePatches";

describe("source editor transaction patches", () => {
  test("a selection replacement stays one proposal even when the words share letters", () => {
    const before = "Hello world", after = "Hello friend";
    const patches = sourceChangePatches(before, after, 0, { changes: [{ rangeOffset: 6, rangeLength: 5, text: "friend" }] });
    expect(patches).toEqual([{ from: 6, to: 11, expected: "world", insert: "friend" }]);
    const review = applyReviewPatches(createReview(before), patches!);
    expect(review.suggestions).toHaveLength(1);
    expect(proposedSource(review)).toBe(after);
  });

  test("multiple cursors use ranges in the same old text despite differing replacement lengths", () => {
    const before = "one middle two last three";
    const after = "FIRST middle SECOND last THIRD";
    const patches = sourceChangePatches(before, after, 0, { changes: [
      { rangeOffset: 20, rangeLength: 5, text: "THIRD" },
      { rangeOffset: 11, rangeLength: 3, text: "SECOND" },
      { rangeOffset: 0, rangeLength: 3, text: "FIRST" },
    ] });
    expect(patches?.map(patch => patch.expected)).toEqual(["three", "two", "one"]);
    expect(proposedSource(applyReviewPatches(createReview(before), patches!))).toBe(after);
    expect(applyReviewPatches(createReview(before), patches!).suggestions).toHaveLength(3);
  });

  test("the old model's metadata BOM shifts every offset exactly once", () => {
    const before = "\ufeffone\r\n😀 two", after = "\ufeffONE\r\n😁 three";
    const patches = sourceChangePatches(before, after, 1, { changes: [
      { rangeOffset: 8, rangeLength: 3, text: "three" },
      { rangeOffset: 5, rangeLength: 2, text: "😁" },
      { rangeOffset: 0, rangeLength: 3, text: "ONE" },
    ] });
    expect(patches).toEqual([
      { from: 9, to: 12, expected: "two", insert: "three" },
      { from: 6, to: 8, expected: "😀", insert: "😁" },
      { from: 1, to: 4, expected: "one", insert: "ONE" },
    ]);
    expect(applySourcePatches({ text: before, format: "mdx", revision: 1 }, 1, patches!).text).toBe(after);
  });

  test("a leading mark in model content is distinct from the separately held BOM", () => {
    expect(sourceChangePatches("\ufeffone", "\ufeffONE", 0, {
      changes: [{ rangeOffset: 1, rangeLength: 3, text: "ONE" }],
    })).toEqual([{ from: 1, to: 4, expected: "one", insert: "ONE" }]);
    expect(sourceChangePatches("one", "\ufeffone", 0, {
      changes: [{ rangeOffset: 0, rangeLength: 0, text: "\ufeff" }],
    })).toEqual([{ from: 0, to: 0, expected: "", insert: "\ufeff" }]);
  });

  test("CRLF offsets and inserted line breaks preserve exact file text", () => {
    const before = "a\r\nb\r\nc", after = "a\r\nnew\r\nlines\r\nc";
    const patches = sourceChangePatches(before, after, 0, { changes: [{ rangeOffset: 3, rangeLength: 1, text: "new\r\nlines" }] });
    expect(patches).toEqual([{ from: 3, to: 4, expected: "b", insert: "new\r\nlines" }]);
    expect(sourceChangePatches(before, after, 0, { changes: [{ rangeOffset: 3, rangeLength: 1, text: "new\nlines" }] })).toBeUndefined();
  });

  test("undo and redo replacement ranges cancel and restore the same source", () => {
    const original = "same same same", changed = "same different same";
    const forward = sourceChangePatches(original, changed, 0, {
      changes: [{ rangeOffset: 5, rangeLength: 4, text: "different" }],
    })!;
    const undo = sourceChangePatches(changed, original, 0, {
      changes: [{ rangeOffset: 5, rangeLength: 9, text: "same" }],
    })!;
    const edited = applyReviewPatches(createReview(original), forward);
    const undone = applyReviewPatches(edited, undo);
    expect(undone.suggestions).toEqual([]);
    expect(proposedSource(applyReviewPatches(undone, forward))).toBe(changed);
    expect(edited.suggestions[0].from).toBe(5);
  });

  test("flush and EOL events fall back, and the next edit can use the replacement's new basis", () => {
    expect(sourceChangePatches("old", "\ufefffresh", 0, {
      isFlush: true, changes: [{ rangeOffset: 0, rangeLength: 3, text: "fresh" }],
    })).toBeUndefined();
    expect(sourceChangePatches("a\r\nb", "a\nb", 0, { isEolChange: true, changes: [] })).toBeUndefined();
    expect(sourceChangePatches("\ufefffresh", "\ufefffresher", 1, {
      changes: [{ rangeOffset: 5, rangeLength: 0, text: "er" }],
    })).toEqual([{ from: 6, to: 6, expected: "", insert: "er" }]);
  });

  test("stale text, invalid model ranges and surrogate splits never yield authoritative patches", () => {
    const before = "A😀B";
    const events = [
      { changes: [{ rangeOffset: 0, rangeLength: 1, text: "X" }] },
      { changes: [{ rangeOffset: -1, rangeLength: 1, text: "X" }] },
      { changes: [{ rangeOffset: 0, rangeLength: -1, text: "X" }] },
      { changes: [{ rangeOffset: 0.5, rangeLength: 1, text: "X" }] },
      { changes: [{ rangeOffset: 0, rangeLength: 100, text: "X" }] },
      { changes: [{ rangeOffset: 2, rangeLength: 1, text: "X" }] },
      { changes: [{ rangeOffset: 1, rangeLength: 1, text: "X" }] },
      { changes: [{ rangeOffset: 0, rangeLength: 3, text: "X" }, { rangeOffset: 1, rangeLength: 3, text: "Y" }] },
    ];
    for (const event of events) expect(sourceChangePatches(before, "unrelated new model", 0, event)).toBeUndefined();
    expect(sourceChangePatches(before, "A\ud83dXB", 0, { changes: [{ rangeOffset: 2, rangeLength: 1, text: "X" }] })).toBeUndefined();
    expect(sourceChangePatches("base", "next", 1, { changes: [] })).toBeUndefined();
    expect(sourceChangePatches("base", "base", 2, { changes: [] })).toBeUndefined();
    expect(sourceChangePatches("base", "base", 0, { changes: [] })).toEqual([]);
  });
});
