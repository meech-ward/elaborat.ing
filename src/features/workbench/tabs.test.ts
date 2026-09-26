import { describe, expect, test } from "bun:test";
import { emptyTabs, tabTransition } from "./tabs";
test.todo("rename keeps unresolved restored identities and persists only the new clean identity (returns with tab persistence: roadmap phase 2 step 10)", () => {});
describe("independent file tabs", () => {
  test("reordering preserves active file, pending reads and exact session objects", () => {
    const tabs = ["a.md", "b.md", "c.md"].map(path => ({ path, content: path, revision: "r", dirty: true }));
    const state = { tabs, active: "b.md", sequence: 9 };
    const reordered = tabTransition(state, { type: "reorder", path: "c.md", target: "a.md", side: "before" });
    expect(reordered.tabs).toEqual([tabs[2], tabs[0], tabs[1]]);
    expect(reordered.tabs[0]).toBe(tabs[2]);
    expect(reordered.active).toBe(state.active);
    expect(reordered.sequence).toBe(9);
    expect(tabTransition(reordered, { type: "reorder", path: "c.md", target: "b.md", side: "after" }).tabs).toEqual(tabs);
    for (const [path, target] of [["a.md", "a.md"], ["missing", "a.md"], ["a.md", "missing"]]) {
      expect(tabTransition(state, { type: "reorder", path, target, side: "before" })).toBe(state);
    }
    expect(tabTransition(state, { type: "reorder", path: "a.md", target: "b.md", side: "before" })).toBe(state);
  });
  test("late reads cannot replace a newer selection and selecting retains session identity", () => {
    let state = tabTransition(emptyTabs, { type: "request", sequence: 1 });
    state = tabTransition(state, { type: "request", sequence: 2 });
    state = tabTransition(state, {
      type: "opened",
      sequence: 2,
      file: { path: "b.md", content: "B", revision: "b" },
    });
    const retained = state.tabs[0];
    state = tabTransition(state, {
      type: "opened",
      sequence: 1,
      file: { path: "a.md", content: "A", revision: "a" },
    });
    expect(state.active).toBe("b.md");
    expect(state.tabs).toEqual([retained]);
    state = tabTransition(state, { type: "request", sequence: 3 });
    state = tabTransition(state, {
      type: "opened",
      sequence: 3,
      file: { path: "c.md", content: "C", revision: "c" },
    });
    state = tabTransition(state, { type: "select", path: "b.md" });
    expect(state.tabs[0]).toBe(retained);
  });
  test("dirty close is refused without explicit discard and preserves other sessions", () => {
    let state = tabTransition(emptyTabs, {
      type: "opened",
      sequence: 0,
      file: { path: "note.md", content: "draft", revision: null },
    });
    state = tabTransition(state, {
      type: "dirty",
      path: "note.md",
      dirty: true,
    });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].dirty).toBe(true);
    expect(
      tabTransition(state, { type: "close", path: "note.md", discard: false }),
    ).toBe(state);
    expect(
      tabTransition(state, { type: "close", path: "note.md", discard: true })
        .tabs,
    ).toEqual([]);
  });
  test("successful rename moves a clean tab onto fresh post-rename bytes, never stale initial content", () => {
    let state = tabTransition(emptyTabs, {
      type: "opened",
      sequence: 0,
      file: { path: "notes/a.md", content: "A", revision: "ra" },
    });
    state = tabTransition(state, { type: "request", sequence: 1 });
    state = tabTransition(state, {
      type: "opened",
      sequence: 1,
      // TabFile holds INITIAL read values: the session may since have
      // saved newer bytes. The renamed action carries a fresh authoritative
      // read taken after the rename, and the reducer must install it, not
      // retain this.
      file: { path: "notes/b.md", content: "stale initial", revision: "rb-old" },
    });
    expect(state.active).toBe("notes/b.md");
    state = tabTransition(state, {
      type: "renamed",
      from: "notes/b.md",
      to: "notes/c.md",
      content: "latest saved",
      revision: "rb-new",
    });
    expect(state.tabs.map((tab) => tab.path)).toEqual(["notes/a.md", "notes/c.md"]);
    expect(state.tabs[1]).toEqual({
      path: "notes/c.md",
      content: "latest saved",
      revision: "rb-new",
      dirty: false,
    });
    expect(state.active).toBe("notes/c.md");
  });
  test("rename of a missing, dirty, draft, or colliding tab leaves state untouched", () => {
    let state = tabTransition(emptyTabs, {
      type: "opened",
      sequence: 0,
      file: { path: "notes/a.md", content: "A", revision: "ra" },
    });
    state = tabTransition(state, { type: "request", sequence: 1 });
    state = tabTransition(state, {
      type: "opened",
      sequence: 1,
      file: { path: "notes/b.md", content: "B", revision: "rb" },
    });
    state = tabTransition(state, { type: "dirty", path: "notes/a.md", dirty: true });
    // A clean draft whose buffer was never reconciled with a saved file
    // must never be relabelled onto fresh saved bytes: that would
    // silently discard the draft.
    const drafted = tabTransition(emptyTabs, {
      type: "opened",
      sequence: 0,
      file: { path: "notes/import.md", content: "imported buffer", revision: null },
    });
    expect(
      tabTransition(drafted, { type: "renamed", from: "notes/import.md", to: "notes/moved.md", content: "server bytes", revision: "r" }),
    ).toBe(drafted);
    expect(
      tabTransition(state, { type: "renamed", from: "notes/missing.md", to: "notes/z.md", content: "Z", revision: "r" }),
    ).toBe(state);
    expect(
      tabTransition(state, { type: "renamed", from: "notes/a.md", to: "notes/z.md", content: "Z", revision: "r" }),
    ).toBe(state);
    expect(
      tabTransition(state, { type: "renamed", from: "notes/b.md", to: "notes/a.md", content: "Z", revision: "r" }),
    ).toBe(state);
    expect(state.active).toBe("notes/b.md");
  });

  test("a new file that was never saved follows its rename with its text, still unsaved; saved or colliding tabs don't", () => {
    let state = tabTransition(emptyTabs, { type: "opened", sequence: 0, file: { path: "notes/untitled.md", content: "old text", revision: null } });
    state = tabTransition(state, { type: "dirty", path: "notes/untitled.md", dirty: true });
    const renamed = tabTransition(state, { type: "draft-renamed", from: "notes/untitled.md", to: "notes/ideas.md", content: "latest text" });
    expect(renamed.active).toBe("notes/ideas.md");
    expect(renamed.tabs).toEqual([{ path: "notes/ideas.md", content: "latest text", revision: null, dirty: true, generation: 1 }]);

    const saved = tabTransition(emptyTabs, { type: "opened", sequence: 0, file: { path: "a.md", content: "a", revision: "r" } });
    expect(tabTransition(saved, { type: "draft-renamed", from: "a.md", to: "b.md", content: "a" })).toBe(saved);
    const both = tabTransition(state, { type: "opened", sequence: 0, file: { path: "notes/ideas.md", content: "x", revision: "r" } });
    expect(tabTransition(both, { type: "draft-renamed", from: "notes/untitled.md", to: "notes/ideas.md", content: "y" })).toBe(both);
  });
});
