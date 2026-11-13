import { expect, test } from "bun:test";
import { isStaleCleanDraft } from "./draftPersistence";

test("a clean saved session cannot recreate a moved or deleted file", () => {
  expect(isStaleCleanDraft(false, "before-move", undefined)).toBe(true);
  expect(isStaleCleanDraft(false, "before-delete", null)).toBe(true);
  expect(isStaleCleanDraft(false, "older", "newer")).toBe(true);
});

test("current clean sessions can clear their former drafts and new files can keep their first draft", () => {
  expect(isStaleCleanDraft(false, "current", "current")).toBe(false);
  expect(isStaleCleanDraft(false, null, undefined)).toBe(false);
  expect(isStaleCleanDraft(false, null, null)).toBe(false);
  expect(isStaleCleanDraft(false, null, "arrived-on-server")).toBe(true);
});

test("real unsaved edits are preserved for recovery even after a move, deletion or newer saved version", () => {
  for (const saved of [undefined, null, "current", "newer"]) {
    expect(isStaleCleanDraft(true, "current", saved)).toBe(false);
    expect(isStaleCleanDraft(true, null, saved)).toBe(false);
  }
});
