import { describe, expect, test } from "bun:test";
import { DocumentEmbedSessions } from "./documentEmbeds";
import type { DocumentEmbedState } from "../rendered/documentEmbeds";
import type { TabFile } from "./tabs";

const frame = {} as Window;
const file = (path: string, content = path): TabFile => ({ path, content, revision: "v1", savedContent: content });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function attach(pool: DocumentEmbedSessions, path: string, id = path, owner = "parent.mdx", ancestors = [owner, path]) {
  const states: DocumentEmbedState[] = [];
  const detach = pool.host(owner).attach({ id, path, ancestors, frame, onState: state => states.push(state) });
  return { states, detach };
}

describe("shared embedded document sessions", () => {
  test("lazy expansion coalesces reads and shares one canonical session with a tab", async () => {
    const reads: string[] = [];
    const pool = new DocumentEmbedSessions(async path => { reads.push(path); return file(path); }, () => {});
    expect(reads).toEqual([]);
    attach(pool, "child.mdx", "first");
    attach(pool, "child.mdx", "second");
    await tick();
    expect(reads).toEqual(["child.mdx"]);
    const original = pool.snapshot().files[0];
    pool.retainTabs([{ ...file("child.mdx", "new initial read"), dirty: false }]);
    expect(pool.snapshot().files[0]).toBe(original);
    expect(pool.snapshot().views).toHaveLength(2);
  });

  test("an already open unsaved tab wins an expansion read", async () => {
    let finish!: (value: TabFile) => void;
    const pool = new DocumentEmbedSessions(() => new Promise(resolve => { finish = resolve; }), () => {});
    attach(pool, "child.md");
    pool.retainTabs([{ ...file("child.md", "unsaved draft"), dirty: true }]);
    finish(file("child.md", "old saved copy"));
    await tick();
    expect(pool.snapshot().files[0]?.content).toBe("unsaved draft");
  });

  test("opening an embedded draft as a tab adopts the live unsaved status", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    attach(pool, "child.md");
    await tick();
    pool.publish("child.md", { dirty: true, pending: false });
    pool.retainTabs([{ ...file("child.md"), dirty: false }]);
    expect(pool.dirty("child.md")).toBe(true);
    pool.publish("child.md", { dirty: false, pending: false });
    expect(pool.dirty("child.md")).toBe(false);
  });

  test("a parent tab adopts unsaved state from its loaded descendants", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    attach(pool, "child.md");
    await tick();
    pool.publish("parent.mdx", { dirty: false, pending: false });
    pool.publish("child.md", { dirty: false, pending: true });
    expect(pool.dirty("parent.mdx")).toBe(true);
    expect(pool.dirty("unknown.md")).toBeUndefined();
  });

  test("explicit tab generations replace the session initial values", () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    pool.retainTabs([{ ...file("child.md"), dirty: false }]);
    pool.retainTabs([{ ...file("child.md", "assistant edit"), generation: 1, dirty: true }]);
    expect(pool.snapshot().files[0]).toMatchObject({ content: "assistant edit", generation: 1 });
  });

  test("closing and reopening a replaced tab keeps the canonical identity and history owner", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    pool.retainTabs([{ ...file("child.md", "moved source"), generation: 1, dirty: false }]);
    attach(pool, "child.md");
    await tick();
    const canonical = pool.snapshot().files[0];
    const epoch = pool.replacementEpoch("child.md");
    pool.publish("child.md", { dirty: true });
    pool.retainTabs([]);
    pool.retainTabs([{ ...file("child.md", "stale reopen read"), dirty: false }]);
    expect(pool.snapshot().files[0]).toBe(canonical);
    expect(pool.replacementEpoch("child.md")).toBe(epoch);
    expect(pool.dirty("child.md")).toBe(true);
  });

  test("a newly joined explicit generation replaces even when its number was used before", () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    pool.retainTabs([{ ...file("child.md", "first assistant version"), generation: 1, dirty: true }]);
    const epoch = pool.replacementEpoch("child.md");
    pool.retainTabs([]);
    pool.retainTabs([{ ...file("child.md", "second assistant version"), generation: 1, dirty: true }]);
    expect(pool.replacementEpoch("child.md")).toBe(epoch + 1);
    expect(pool.snapshot().files[0]?.content).toBe("second assistant version");
    pool.retainTabs([{ ...file("child.md", "second assistant version"), generation: 1, dirty: false }]);
    expect(pool.replacementEpoch("child.md")).toBe(epoch + 1);
  });

  test("reusing an explicit generation after an ordinary reopen is an intentional replacement", () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    pool.retainTabs([{ ...file("child.md", "first assistant version"), generation: 1, dirty: true }]);
    pool.retainTabs([]);
    pool.retainTabs([{ ...file("child.md", "ordinary reopen"), dirty: false }]);
    const epoch = pool.replacementEpoch("child.md");
    pool.retainTabs([{ ...file("child.md", "new assistant version"), generation: 1, dirty: true }]);
    expect(pool.replacementEpoch("child.md")).toBe(epoch + 1);
    expect(pool.snapshot().files[0]?.content).toBe("new assistant version");
  });

  test.each([
    ["https://example.com/a.md", ["parent.mdx", "https://example.com/a.md"]],
    ["../secret.md", ["parent.mdx", "../secret.md"]],
    ["image.png", ["parent.mdx", "image.png"]],
    ["drawing.excalidraw.md", ["parent.mdx", "drawing.excalidraw.md"]],
    ["parent.mdx", ["parent.mdx", "parent.mdx"]],
    ["child.md", ["different.mdx", "child.md"]],
    ["child.md", ["one.md", "two.md", "three.md", "four.md", "parent.mdx", "child.md"]],
  ])("refuses invalid embed authority %s", async (path, ancestors) => {
    let reads = 0;
    const pool = new DocumentEmbedSessions(async value => { reads++; return file(value); }, () => {});
    const view = attach(pool, path as string, "invalid", "parent.mdx", ancestors as string[]);
    await tick();
    expect(reads).toBe(0);
    expect(pool.snapshot().views).toEqual([]);
    expect(view.states.at(-1)?.error).toBeTruthy();
  });

  test("missing documents report their filename and detach releases only that view", async () => {
    const pool = new DocumentEmbedSessions(async () => { throw new Error("Missing file"); }, () => {});
    const first = attach(pool, "missing.md", "first");
    const second = attach(pool, "missing.md", "second");
    await tick();
    expect(first.states.at(-1)).toMatchObject({ pending: false, error: "Cannot open missing.md: Missing file" });
    first.detach();
    expect(pool.snapshot().views.map(view => view.id)).toEqual(["second"]);
    second.detach();
    expect(pool.snapshot().views).toEqual([]);
  });

  test("publishes one shared dirty state and includes hidden files in operation guards", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    const first = attach(pool, "child.md", "first");
    const second = attach(pool, "child.md", "second");
    await tick();
    pool.publish("child.md", { dirty: true, pending: false });
    expect(first.states.at(-1)?.dirty).toBe(true);
    expect(second.states.at(-1)?.dirty).toBe(true);
    expect(pool.descendantsDirty("parent.mdx")).toBe(true);
    expect(pool.operationTabs([])).toMatchObject([{ path: "child.md", dirty: true }]);
    expect(pool.operationTabs([{ ...file("child.md"), dirty: true }])).toHaveLength(1);
  });

  test("open and custom-code actions stay with their owning view", async () => {
    const opened: string[] = [];
    let ran = 0;
    const pool = new DocumentEmbedSessions(async path => file(path), path => opened.push(path));
    const { detach } = attach(pool, "child.md", "view");
    pool.register("child.md", { save: async () => true, run: () => { ran++; } });
    pool.host("elsewhere.mdx").action("view", "open");
    expect(opened).toEqual([]);
    pool.host("parent.mdx").action("view", "open");
    pool.host("parent.mdx").action("view", "run");
    expect(opened).toEqual(["child.md"]);
    expect(ran).toBe(1);
    detach();
    pool.host("parent.mdx").action("view", "open");
    expect(opened).toHaveLength(1);
  });

  test("parent Save writes descendants once in child-first order and reports filename failures", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    attach(pool, "child.md", "child-one");
    attach(pool, "child.md", "child-two");
    attach(pool, "grandchild.md", "grandchild", "child.md", ["parent.mdx", "child.md", "grandchild.md"]);
    await tick();
    const saved: string[] = [];
    for (const path of ["parent.mdx", "child.md", "grandchild.md"]) {
      pool.publish(path, { dirty: true });
      pool.register(path, { run: () => {}, save: async () => { saved.push(path); return path !== "child.md"; } });
    }
    expect(await pool.saveTree("parent.mdx")).toEqual(["Could not save child.md. Open it separately to review its changes."]);
    expect(saved).toEqual(["grandchild.md", "child.md", "parent.mdx"]);
    saved.length = 0;
    await pool.saveTree("parent.mdx", false);
    expect(saved).toEqual(["grandchild.md", "child.md"]);
  });

  test("clean children are skipped while an edit in flight is saved", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    attach(pool, "clean.md");
    attach(pool, "pending.md");
    await tick();
    const saved: string[] = [];
    for (const path of ["clean.md", "pending.md"]) pool.register(path, { run: () => {}, save: async () => { saved.push(path); return true; } });
    pool.publish("clean.md", { dirty: false, pending: false });
    pool.publish("pending.md", { dirty: false, pending: true });
    expect(await pool.saveTree("parent.mdx", false)).toEqual([]);
    expect(saved).toEqual(["pending.md"]);
  });

  test("old registration cleanup cannot remove a newer live writer", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    pool.publish("child.md", { dirty: true });
    const old = pool.register("child.md", { run: () => {}, save: async () => false });
    pool.register("child.md", { run: () => {}, save: async () => true });
    old();
    expect(await pool.saveTree("child.md")).toEqual([]);
  });

  test("bounds active views even when they all repeat one file", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    for (let index = 0; index < 64; index++) attach(pool, "child.md", `view-${index}`);
    const extra = attach(pool, "child.md", "too-many");
    await tick();
    expect(pool.snapshot().views).toHaveLength(64);
    expect(pool.snapshot().files).toHaveLength(1);
    expect(extra.states.at(-1)).toMatchObject({ pending: false, error: expect.stringContaining("Too many embedded documents") });
  });

  test("a deleted file cannot be resurrected by an outstanding expansion read", async () => {
    let finish!: (value: TabFile) => void;
    const pool = new DocumentEmbedSessions(() => new Promise(resolve => { finish = resolve; }), () => {});
    attach(pool, "child.md");
    pool.forget("child.md");
    finish(file("child.md"));
    await tick();
    expect(pool.snapshot().files).toEqual([]);
  });

  test("move reconciliation removes clean stale paths but preserves an unsaved draft", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    attach(pool, "clean.md");
    attach(pool, "draft.md");
    await tick();
    pool.publish("draft.md", { dirty: true });
    pool.reconcilePaths([]);
    expect(pool.snapshot().files.map(file => file.path)).toEqual(["draft.md"]);
  });

  test("forgetting a deleted file disables surviving references without deleting references", async () => {
    const pool = new DocumentEmbedSessions(async path => file(path), () => {});
    const view = attach(pool, "child.md");
    await tick();
    pool.forget("child.md");
    expect(pool.snapshot().files).toEqual([]);
    expect(pool.snapshot().views).toHaveLength(1);
    expect(view.states.at(-1)).toMatchObject({ readOnly: true, error: "child.md is not in this project." });
  });
});
