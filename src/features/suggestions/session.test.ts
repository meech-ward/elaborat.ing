import { describe, expect, test } from "bun:test";
import { LocalReviewSession } from "./session";
import { proposedSource } from "./review";
import type { ReviewDraft, StoredReviewDraft } from "./storage";

type Persistence = NonNullable<ConstructorParameters<typeof LocalReviewSession>[4]>;
type SaveCall = { record: ReviewDraft | null; expectedToken: string | null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function memory(saved: StoredReviewDraft | null = null) {
  let sequence = 0;
  const mock = {
    saved,
    calls: [] as SaveCall[],
    failure: null as Error | null,
    beforeSave: undefined as ((call: SaveCall, count: number) => Promise<void> | void) | undefined,
    persistence: null as unknown as Persistence,
  };
  mock.persistence = {
    load: () => structuredClone(mock.saved),
    save: async (_scope, _file, record, expectedToken) => {
      const call = { record: structuredClone(record), expectedToken };
      mock.calls.push(call);
      await mock.beforeSave?.(call, mock.calls.length);
      if (mock.failure) { const error = mock.failure; mock.failure = null; throw error; }
      if ((mock.saved?.token ?? null) !== expectedToken) throw new Error("Changed in another tab");
      mock.saved = record === null ? null : { ...structuredClone(record), token: `token-${++sequence}` };
      return structuredClone(mock.saved);
    },
  };
  return mock;
}

function session(storage = memory()) {
  return { storage, session: new LocalReviewSession("backend/account/project", "file-id", "notes/example.mdx", "mdx", storage.persistence) };
}

function source(current: LocalReviewSession): string {
  const document = current.snapshot().document;
  if (!document) throw new Error("Missing review document");
  return document.text;
}

describe("local review session", () => {
  test("keeping and its finalization retain the document snapshot reference", async () => {
    const { session: current, storage } = session();
    const writing = deferred();
    storage.beforeSave = () => writing.promise;
    current.start("base", "version-1");
    const document = current.snapshot().document;
    const published: Array<typeof document> = [];
    const unsubscribe = current.subscribe(() => { published.push(current.snapshot().document); });
    expect(current.snapshot().keeping).toBe(true);
    const pending = current.keep();
    writing.resolve();
    await pending;
    expect(current.snapshot()).toMatchObject({ keeping: false, kept: true });
    expect(current.snapshot().document).toBe(document);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every(snapshot => snapshot === document)).toBe(true);
    unsubscribe();
  });

  test("busy cancellation and commit errors publish metadata without replacing the source snapshot", async () => {
    const { session: current } = session();
    current.start("base", "version-1");
    current.changeSource("proposed");
    await current.keep();
    const document = current.snapshot().document;
    const published: Array<typeof document> = [];
    const unsubscribe = current.subscribe(() => { published.push(current.snapshot().document); });
    const deciding = deferred();
    const pending = current.accept(null, async () => { await deciding.promise; return null; });
    expect(current.snapshot().busy).toBe(true);
    expect(current.snapshot().document).toBe(document);
    deciding.resolve();
    await pending;
    expect(current.snapshot().busy).toBe(false);
    expect(current.snapshot().document).toBe(document);
    await expect(current.accept(null, async () => { throw new Error("Commit failed"); })).rejects.toThrow("Commit failed");
    expect(current.snapshot().error).toBe("Commit failed");
    expect(current.snapshot().document).toBe(document);
    expect(published.every(snapshot => snapshot === document)).toBe(true);
    unsubscribe();
  });

  test("storage errors and retries keep the same source object throughout status publications", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    await current.keep();
    storage.failure = new Error("Storage unavailable");
    current.changeSource("proposed");
    const document = current.snapshot().document;
    await expect(current.keep()).rejects.toThrow("Storage unavailable");
    expect(current.snapshot()).toMatchObject({ error: "Storage unavailable", kept: false, keeping: false });
    expect(current.snapshot().document).toBe(document);
    await current.keep();
    expect(current.snapshot()).toMatchObject({ error: null, kept: true, keeping: false });
    expect(current.snapshot().document).toBe(document);
  });

  test("source edits, undo and decisions replace immutable snapshots even when text returns to its prior value", async () => {
    const { session: current } = session();
    current.start("base", "version-1");
    const initial = current.snapshot().document!;
    current.changeSource("proposed");
    const changed = current.snapshot().document!;
    expect(changed).not.toBe(initial);
    expect(initial.text).toBe("base");
    expect(changed.text).toBe("proposed");
    current.changeSource("base");
    const undone = current.snapshot().document!;
    expect(undone).not.toBe(changed);
    expect(undone).not.toBe(initial);
    expect(undone.revision).toBeGreaterThan(changed.revision);
    current.reject(null);
    const decided = current.snapshot().document!;
    expect(decided).not.toBe(undone);
    expect(decided.text).toBe(undone.text);
    expect(decided.docId).toBeGreaterThan(undone.docId);
    await current.keep();
    expect(current.snapshot().document).toBe(decided);
    await current.stop();
    expect(current.snapshot().document).toBeNull();
  });

  test("typing and rejection keep proposals without file-writing authority", async () => {
    const { session: current, storage } = session();
    current.start("Hello world", "file-version-1");
    current.changeSource("Hello friend");
    await current.keep();
    expect(current.snapshot().review?.base).toBe("Hello world");
    expect(source(current)).toBe("Hello friend");
    expect(storage.saved?.base).toBe("Hello world");
    expect(storage.saved!.suggestions.length).toBeGreaterThan(0);
    expect(current.snapshot()).toMatchObject({ kept: true, busy: false, keeping: false, error: null });
    const identity = current.snapshot().document!.docId;
    current.reject(null);
    await current.keep();
    expect(source(current)).toBe("Hello world");
    expect(current.snapshot().document!.docId).toBeGreaterThan(identity);
    expect(storage.saved?.suggestions).toEqual([]);
  });

  test("explicit acceptance writes only accepted base at the exact revision", async () => {
    const { session: current } = session();
    current.start("alpha middle omega", "version-1");
    current.changeSource("ALPHA middle OMEGA");
    await current.keep();
    const before = current.snapshot();
    expect(before.review?.suggestions).toHaveLength(2);
    const calls: Array<{ next: string; base: string; revision: string }> = [];
    const commit = async (next: string, base: string, revision: string) => {
      calls.push({ next, base, revision });
      return `version-${calls.length + 1}`;
    };
    await current.accept(before.review!.suggestions[0].id, commit);
    expect(calls).toEqual([{ next: "ALPHA middle omega", base: "alpha middle omega", revision: "version-1" }]);
    expect(source(current)).toBe("ALPHA middle OMEGA");
    expect(current.snapshot().review?.suggestions).toHaveLength(1);
    expect(current.snapshot().baseRevision).toBe("version-2");
    expect(current.snapshot().document!.docId).toBeGreaterThan(before.document!.docId);
    await current.accept(null, commit);
    expect(calls[1]).toEqual({ next: "ALPHA middle OMEGA", base: "ALPHA middle omega", revision: "version-2" });
    expect(current.snapshot().baseRevision).toBe("version-3");
    expect(current.snapshot().review?.suggestions).toEqual([]);
    await current.accept(null, commit);
    expect(calls).toHaveLength(2);
  });

  test("canceling acceptance leaves the review and its undo identity unchanged", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    current.changeSource("proposed");
    await current.keep();
    const before = structuredClone(current.snapshot());
    await current.accept(null, async () => null);
    expect(current.snapshot().review).toEqual(before.review);
    expect(current.snapshot().document).toEqual(before.document);
    expect(current.snapshot()).toMatchObject({ busy: false, baseRevision: "version-1", error: null });
    expect(storage.saved?.base).toBe("base");
    expect(proposedSource(storage.saved!)).toBe("proposed");
  });

  test("precise source transactions retain selection replacement and multicursor intent", async () => {
    const { session: current } = session();
    current.start("Hello world", "version-1");
    current.changeSource("Hello friend", [{ from: 6, to: 11, expected: "world", insert: "friend" }]);
    expect(current.snapshot().review?.suggestions).toHaveLength(1);
    const before = structuredClone(current.snapshot());
    expect(() => current.changeSource("unrelated text", [{ from: 0, to: 5, expected: "Hello", insert: "Goodbye" }])).toThrow(/do not match/);
    expect(current.snapshot()).toEqual(before);
    // Echoes of checked rendered patches are already applied and must not be replayed.
    current.changeSource("Hello friend", [{ from: 6, to: 11, expected: "world", insert: "friend" }]);
    expect(current.snapshot()).toEqual(before);
    current.reject(null);
    current.changeSource("Goodbye friend", [
      { from: 6, to: 11, expected: "world", insert: "friend" },
      { from: 0, to: 5, expected: "Hello", insert: "Goodbye" },
    ]);
    expect(current.snapshot().review?.suggestions).toHaveLength(2);
    await current.keep();
    expect(source(current)).toBe("Goodbye friend");
  });

  test("commit failure preserves every proposed byte, revision and undo identity", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    current.changeSource("proposed");
    await current.keep();
    const before = structuredClone(current.snapshot());
    await expect(current.accept(null, async () => { throw new Error("Remote revision changed"); })).rejects.toThrow("Remote revision changed");
    expect(current.snapshot().review).toEqual(before.review);
    expect(current.snapshot().document).toEqual(before.document);
    expect(current.snapshot().baseRevision).toBe("version-1");
    expect(current.snapshot()).toMatchObject({ busy: false, kept: true, error: "Remote revision changed" });
    expect(storage.saved?.base).toBe("base");
    expect(proposedSource(storage.saved!)).toBe("proposed");
  });

  test("unkept proposals prevent commit and remain recoverable after storage failure", async () => {
    const storage = memory();
    storage.failure = new Error("Storage full");
    const { session: current } = session(storage);
    current.start("base", "version-1");
    current.changeSource("draft");
    let writes = 0;
    await expect(current.accept(null, async () => { writes++; return "version-2"; })).rejects.toThrow("Storage full");
    expect(writes).toBe(0);
    expect(source(current)).toBe("draft");
    expect(current.snapshot()).toMatchObject({ kept: false, busy: false, baseRevision: "version-1" });
    await current.keep();
    expect(current.snapshot()).toMatchObject({ kept: true, error: null });
    expect(proposedSource(storage.saved!)).toBe("draft");
  });

  test("a storage failure after commit preserves the successful file revision without committing twice", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    current.changeSource("accepted");
    await current.keep();
    let writes = 0;
    await expect(current.accept(null, async () => {
      writes++;
      storage.failure = new Error("Storage full after commit");
      return "version-2";
    })).rejects.toThrow("Storage full after commit");
    expect(current.snapshot().review).toEqual({ base: "accepted", suggestions: [] });
    expect(current.snapshot()).toMatchObject({ baseRevision: "version-2", kept: false, busy: false });
    expect(source(current)).toBe("accepted");
    await current.keep();
    await current.accept(null, async () => { writes++; return "unexpected"; });
    expect(writes).toBe(1);
    expect(storage.saved).toMatchObject({ base: "accepted", baseRevision: "version-2", suggestions: [] });
  });

  test("restoring a sidecar preserves its source, revision and compare-and-swap token", async () => {
    const storage = memory({ token: "restored-token", base: "one two", baseRevision: "saved-version", suggestions: [
      { id: "pending", from: 4, to: 7, expected: "two", insert: "THREE" },
    ] });
    const { session: current } = session(storage);
    current.restore();
    expect(source(current)).toBe("one THREE");
    expect(current.snapshot()).toMatchObject({ baseRevision: "saved-version", kept: true });
    expect(storage.calls).toHaveLength(0);
    current.changeSource("one THREES");
    await current.keep();
    expect(storage.calls[0].expectedToken).toBe("restored-token");
    expect(storage.saved?.suggestions[0].id).toBe("pending");
  });

  test("start restores an existing draft instead of replacing it with newer file bytes", () => {
    const storage = memory({ token: "existing", base: "older", baseRevision: "old-version", suggestions: [
      { id: "pending", from: 0, to: 5, expected: "older", insert: "local" },
    ] });
    const { session: current } = session(storage);
    current.start("newer remote", "new-version");
    expect(source(current)).toBe("local");
    expect(current.snapshot().baseRevision).toBe("old-version");
    expect(storage.calls).toHaveLength(0);
  });

  test("invalid restore fails before exposing a half-restored review", () => {
    const storage = memory({ token: "invalid", base: "base", baseRevision: "version-1", suggestions: [
      { id: "broken", from: 0, to: 4, expected: "other", insert: "changed" },
    ] });
    const { session: current } = session(storage);
    current.restore();
    expect(current.snapshot().review).toBeNull();
    expect(current.snapshot().document).toBeNull();
    expect(current.snapshot().baseRevision).toBeNull();
    expect(current.snapshot().error).toMatch(/mismatch/);
    expect(storage.saved?.suggestions[0].expected).toBe("other");
  });

  test("partial rejection preserves other proposals and rejection resets typing history", async () => {
    const { session: current } = session();
    current.start("alpha middle omega", "version-1");
    current.changeSource("ALPHA middle OMEGA");
    const before = current.snapshot();
    const first = before.review!.suggestions[0].id;
    const last = before.review!.suggestions[1];
    current.reject(first);
    await current.keep();
    expect(source(current)).toBe("alpha middle OMEGA");
    expect(current.snapshot().review?.suggestions).toEqual([last]);
    expect(current.snapshot().document!.docId).toBeGreaterThan(before.document!.docId);
    expect(current.snapshot().baseRevision).toBe("version-1");
  });

  test("stop clears the sidecar only after all proposals have been decided", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    current.changeSource("draft");
    await expect(current.stop()).rejects.toThrow(/remaining/);
    expect(source(current)).toBe("draft");
    current.reject(null);
    await current.stop();
    expect(storage.saved).toBeNull();
    expect(current.snapshot()).toMatchObject({ review: null, document: null, baseRevision: null, busy: false, kept: true });
  });

  test("failed stop retries the requested removal instead of recreating a draft", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    await current.keep();
    storage.failure = new Error("Cannot remove stored draft");
    await expect(current.stop()).rejects.toThrow("Cannot remove stored draft");
    expect(current.snapshot().review?.base).toBe("base");
    expect(storage.saved).not.toBeNull();
    await current.keep();
    expect(storage.calls.at(-1)?.record).toBeNull();
    expect(storage.saved).toBeNull();
    await current.stop();
    expect(current.snapshot().review).toBeNull();
  });

  test("typing while a storage write waits coalesces to the latest source", async () => {
    const { session: current, storage } = session();
    const first = deferred(), second = deferred();
    storage.beforeSave = (_call, count) => count === 1 ? first.promise : count === 2 ? second.promise : undefined;
    current.start("base", "version-1");
    await Promise.resolve();
    current.changeSource("first");
    current.changeSource("latest");
    let kept = false;
    const pending = current.keep().then(() => { kept = true; });
    first.resolve();
    for (let count = 0; count < 8; count++) await Promise.resolve();
    expect(storage.calls).toHaveLength(2);
    expect(proposedSource(storage.calls[1].record!)).toBe("latest");
    expect(kept).toBe(false);
    second.resolve();
    await pending;
    expect(kept).toBe(true);
    expect(proposedSource(storage.saved!)).toBe("latest");
    expect(storage.calls[1].expectedToken).toBe("token-1");
  });

  test("keep follows an edit queued between the drain loop and its finalizer", async () => {
    const { session: current, storage } = session();
    storage.beforeSave = (_call, count) => {
      if (count === 1) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => current.changeSource("late edit"))));
    };
    current.start("base", "version-1");
    await current.keep();
    expect(source(current)).toBe("late edit");
    expect(proposedSource(storage.saved!)).toBe("late edit");
    expect(current.snapshot()).toMatchObject({ kept: true, keeping: false });
  });

  test("stale rendered patches and no-op patches leave the current review untouched", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    await current.keep();
    const before = structuredClone(current.snapshot());
    expect(() => current.applyPatches(before.document!.revision - 1, [{ from: 0, to: 4, expected: "base", insert: "next" }])).toThrow(/stale/);
    expect(current.snapshot()).toEqual(before);
    current.applyPatches(before.document!.revision, []);
    await current.keep();
    expect(storage.calls).toHaveLength(1);
    current.applyPatches(before.document!.revision, [{ from: 0, to: 4, expected: "base", insert: "next" }]);
    await current.keep();
    expect(source(current)).toBe("next");
    expect(current.snapshot().review?.base).toBe("base");
  });

  test("incomplete MDX and exact CRLF bytes survive proposals, persistence and acceptance", async () => {
    const { session: current, storage } = session();
    const base = "import { Card } from 'workspace:card.mdx'\r\n\r\n# 😀\r\n\r\n<Card value={1} />\r\n";
    const next = base.replace("<Card value={1} />", "<Card value={");
    current.start(base, "version-1");
    current.changeSource(next);
    await current.keep();
    expect(source(current)).toBe(next);
    expect(proposedSource(storage.saved!)).toBe(next);
    await current.accept(null, async (accepted, original, revision) => {
      expect(accepted).toBe(next);
      expect(original).toBe(base);
      expect(revision).toBe("version-1");
      return "version-2";
    });
    expect(current.snapshot().review?.base).toBe(next);
  });

  test("busy acceptance blocks editing while retaining the exact captured source", async () => {
    const { session: current } = session();
    const writing = deferred();
    current.start("base", "version-1");
    current.changeSource("next");
    const pending = current.accept(null, async () => { await writing.promise; return "version-2"; });
    expect(current.snapshot().busy).toBe(true);
    expect(() => current.changeSource("later")).toThrow(/cannot change/);
    expect(() => current.reject(null)).toThrow(/cannot change/);
    writing.resolve();
    await pending;
    expect(source(current)).toBe("next");
    expect(current.snapshot().busy).toBe(false);
  });

  test("another tab's token conflict never erases the current proposed source", async () => {
    const { session: current, storage } = session();
    current.start("base", "version-1");
    await current.keep();
    storage.saved!.token = "other-tab-token";
    current.changeSource("my unsaved proposal");
    await expect(current.keep()).rejects.toThrow("Changed in another tab");
    expect(source(current)).toBe("my unsaved proposal");
    expect(current.snapshot().kept).toBe(false);
    expect(storage.saved?.base).toBe("base");
    expect(storage.saved?.suggestions).toEqual([]);
  });
});
