import { expect, test } from "bun:test";
import { isStructuralHistoryBoundary } from "../source/renderedHistory";

test("cross-paragraph replacement starts one typing undo group, while split/join remains separate", () => {
  expect(
    isStructuralHistoryBoundary(2, 1, [
      { stepType: "replace", slice: { content: [{ text: "J" }] } },
    ]),
  ).toBe(false);
  expect(
    isStructuralHistoryBoundary(2, 2, [
      { stepType: "replace", slice: { content: [{ text: "O" }] } },
    ]),
  ).toBe(false);
  expect(
    isStructuralHistoryBoundary(1, 2, [
      { stepType: "replace", slice: { content: [{}, {}] } },
    ]),
  ).toBe(true);
  expect(isStructuralHistoryBoundary(2, 1, [{ stepType: "replace" }])).toBe(
    true,
  );
});
