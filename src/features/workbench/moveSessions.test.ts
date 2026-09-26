import { expect, test } from "bun:test";
import { moveSessionProblem } from "./moveSessions";
import type { OperationState } from "./operationSession";
import { tabTransition, type TabState } from "./tabs";

test("a move waits for open files it touches to be saved and settled, and for its destination tabs to close", () => {
  const plan = { moves: [{ from: "a.md", to: "folder/a.md" }], updates: [{ path: "refs.mdx", references: [] }] };
  const tab = { path: "refs.mdx", content: "before", revision: "1", dirty: false };
  const ready: OperationState = { dirty: false, pending: false, saving: false, reconciled: true };
  const session = (state: OperationState) => new Map([[tab.path, { state: () => state, freeze() {}, release() {} }]]);
  for (const state of [{ ...ready, saving: true }, { ...ready, pending: true }, { ...ready, reconciled: false }, { ...ready, dirty: true }]) {
    expect(moveSessionProblem(plan, [tab], session(state))).not.toBeNull();
  }
  expect(moveSessionProblem(plan, [{ ...tab, dirty: true }], session(ready))).toMatch(/unsaved changes/);
  expect(moveSessionProblem(plan, [{ ...tab, path: "folder/a.md", revision: null }], new Map())).toMatch(/already open/);
  expect(moveSessionProblem(plan, [tab], session(ready))).toBeNull();
  expect(moveSessionProblem(plan, [{ ...tab, path: "elsewhere.md", dirty: true }], new Map())).toBeNull();
});

test("after a move, moved and rewritten tabs are replaced together and other tabs keep their identity", () => {
  const draft = { path: "draft.md", content: "unsaved", revision: null, dirty: true };
  const state: TabState = {
    sequence: 3,
    active: "a.md",
    tabs: [{ path: "a.md", content: "original", revision: "1", dirty: false }, { path: "refs.mdx", content: "old ref", revision: "2", dirty: false }, draft],
  };
  const result = tabTransition(state, {
    type: "move-reconciled",
    files: [
      { from: "a.md", path: "folder/a.md", content: "original", revision: "1" },
      { from: "refs.mdx", path: "refs.mdx", content: "new ref", revision: "3" },
    ],
  });
  expect(result.active).toBe("folder/a.md");
  expect(result.tabs.map(tab => tab.path)).toEqual(["folder/a.md", "refs.mdx", "draft.md"]);
  expect(result.tabs[1].content).toBe("new ref");
  expect(result.tabs[1].generation).toBe(1);
  expect(result.tabs[2]).toBe(draft);
});
