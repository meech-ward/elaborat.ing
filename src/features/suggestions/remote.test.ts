import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { contentToken } from "../project-storage/model";
import { SupabaseReviewRemote, type SharedReviewRecord } from "./remote";
import { LocalReviewSession } from "./session";
import { acceptReviewSuggestion, proposedSource, rejectReviewSuggestion, type ReviewState } from "./review";
import type { PortableReviewBundle } from "./portable";

const projectId = "aaaaaaaa-0000-4000-8000-000000000001";
const fileId = "bbbbbbbb-0000-4000-8000-000000000001";
const userId = "cccccccc-0000-4000-8000-000000000001";
const path = "notes/example.mdx";
const base = "alpha middle omega";
const bundle = (): PortableReviewBundle => ({
  format: "elaborating-review", version: 1, path, base,
  suggestions: [
    { id: "first", from: 0, to: 5, expected: "alpha", insert: "A", sourceIds: ["revision:1"] },
    { id: "last", from: 13, to: 18, expected: "omega", insert: "Z" },
  ],
  provenance: { label: "Original document", base, proposed: "A middle Z", annotations: [
    { id: "revision:1", kind: "replacement", author: "Original author", rawXml: "<change/>" },
    { id: "comment:1", kind: "comment", text: "Original comment", anchor: { projection: "proposed", from: 0, to: 1, quote: "A" } },
  ] },
});

function backend() {
  const state = {
    row: null as SharedReviewRecord | null,
    file: { id: fileId, path, version: 1, content: base },
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    receipts: new Map<string, { request: string; result: unknown }>(),
    unavailable: false,
    loseSaveResponse: false,
    loseDecisionResponse: false,
    fileWrites: 0,
    responseTransform: undefined as ((result: unknown) => unknown) | undefined,
    afterCommit: undefined as (() => Promise<void>) | undefined,
    activeUserId: userId,
    afterSessionRead: undefined as (() => void) | undefined,
    bearers: [] as string[],
  };
  const refusal = (code: string) => ({ data: null, error: { code, message: "Refused" } });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    state.calls.push({ name, args: structuredClone(args) });
    if (state.unavailable) throw new Error("Offline");
    if (args.project_id !== projectId) return refusal("42501");
    if (name === "get_note_review") return { data: state.responseTransform?.({ review: state.row }) ?? { review: structuredClone(state.row) }, error: null };
    const mutation = String(args.mutation_id);
    const signature = JSON.stringify([name, args]);
    const receipt = state.receipts.get(mutation);
    if (receipt) return receipt.request === signature ? { data: structuredClone(receipt.result), error: null } : refusal("22023");
    let result: unknown;
    if (name === "save_note_review") {
      const current = state.row?.status === "open" ? state.row : null;
      if ((current?.version ?? null) !== args.expected_version || args.base_version !== state.file.version) return refusal("40001");
      const payload = structuredClone(args.payload as ReviewState);
      state.row = {
        id: String(args.review_id), project_id: projectId, file_id: fileId, path,
        base_version: state.file.version, version: (current?.version ?? 0) + 1, status: "open", payload,
        original_bundle: current?.original_bundle ?? structuredClone(payload),
        created_by: userId, updated_by: userId, created_at: "2026-11-17", updated_at: "2026-11-17", closed_at: null,
      };
      result = { review: state.row };
    } else {
      if (!state.row || state.row.id !== args.review_id || state.row.version !== args.expected_version) return refusal("40001");
      if (name === "decide_note_review") {
        const previous = state.row.payload;
        const id = args.suggestion_id as string | null;
        const accepting = args.decision === "accept";
        const payload = accepting
          ? id === null ? { ...previous, base: proposedSource(previous), suggestions: [] } : acceptReviewSuggestion(previous, id)
          : id === null ? { ...previous, suggestions: [] } : rejectReviewSuggestion(previous, id);
        if (accepting) { state.file = { ...state.file, content: payload.base, version: state.file.version + 1 }; state.fileWrites++; }
        state.row = { ...state.row, payload, base_version: state.file.version, version: state.row.version + 1 };
        result = { review: state.row, file: accepting ? state.file : null };
      } else if (name === "finish_note_review") {
        if (state.row.payload.suggestions.length) return refusal("22023");
        state.row = { ...state.row, status: "closed", closed_at: "2026-11-17", version: state.row.version + 1 };
        result = { review: state.row };
      } else return refusal("22023");
    }
    state.receipts.set(mutation, { request: signature, result: structuredClone(result) });
    await state.afterCommit?.();
    if (name === "save_note_review" && state.loseSaveResponse) { state.loseSaveResponse = false; throw new Error("Lost success response"); }
    if (name === "decide_note_review" && state.loseDecisionResponse) { state.loseDecisionResponse = false; throw new Error("Lost decision response"); }
    return { data: state.responseTransform?.(result) ?? structuredClone(result), error: null };
  };
  const client = {
    auth: { getSession: async () => {
      const session = { user: { id: state.activeUserId }, access_token: `token-${state.activeUserId}` };
      state.afterSessionRead?.();
      return { data: { session }, error: null };
    } },
    rpc: (name: string, args: Record<string, unknown>) => Object.assign(Promise.resolve().then(() => invoke(name, args)), {
      setHeader(_name: string, value: string) { state.bearers.push(value); return this; },
    }),
  } as unknown as Pick<SupabaseClient, "auth" | "rpc">;
  const remote = () => new SupabaseReviewRemote(client, { userId, projectId, fileId, baseVersion: state.file.version });
  const session = () => new LocalReviewSession("backend/account/project", crypto.randomUUID(), path, "mdx", remote());
  return { state, remote, session };
}

describe("shared review transport", () => {
  test("targets real server identities and validates source/provenance on reads", async () => {
    const { state, remote } = backend();
    const transport = remote();
    expect(await transport.load()).toBeNull();
    expect(state.calls[0]).toEqual({ name: "get_note_review", args: { project_id: projectId, file_id: fileId } });
    const imported = bundle();
    const record = await transport.save({ base: imported.base, suggestions: imported.suggestions, provenance: imported.provenance }, null, crypto.randomUUID());
    expect(record.original_bundle.provenance).toEqual(imported.provenance);
    expect(state.calls[1].args).toMatchObject({ project_id: projectId, file_id: fileId, expected_version: null, base_version: 1 });
    state.responseTransform = () => ({ review: { ...record, file_id: crypto.randomUUID() } });
    await expect(transport.load()).rejects.toThrow("could not be verified");
    state.responseTransform = () => ({ review: { ...record, payload: { ...record.payload, suggestions: [{ ...record.payload.suggestions[0], expected: "wrong" }] } } });
    await expect(transport.load()).rejects.toThrow("could not be verified");
  });

  test("a lost create response retains the same review identity and mutation request", async () => {
    const { state, remote } = backend();
    const transport = remote();
    const mutation = crypto.randomUUID();
    state.loseSaveResponse = true;
    await expect(transport.save({ base, suggestions: [] }, null, mutation)).rejects.toThrow("could not be reached");
    const record = await transport.save({ base, suggestions: [] }, null, mutation);
    expect(record.version).toBe(1);
    expect(state.calls[0].args).toEqual(state.calls[1].args);
  });

  test("server conflicts remain visible and never turn into browser writes", async () => {
    const { remote } = backend();
    const record = await remote().save({ base, suggestions: [] }, null, crypto.randomUUID());
    await expect(remote().save({ base, suggestions: [] }, { ...record, version: 99 }, crypto.randomUUID())).rejects.toMatchObject({ kind: "conflict" });
  });

  test("an account switch refuses queued calls, and a captured request keeps its checked bearer", async () => {
    const { state, remote } = backend();
    const transport = remote();
    state.activeUserId = crypto.randomUUID();
    await expect(transport.load()).rejects.toThrow("signed-in account changed");
    expect(state.calls).toHaveLength(0);
    state.activeUserId = userId;
    state.afterSessionRead = () => { state.activeUserId = crypto.randomUUID(); };
    expect(await transport.load()).toBeNull();
    expect(state.bearers).toEqual([`Bearer token-${userId}`]);
  });

  test("disposal during an auth check prevents the RPC from dispatching", async () => {
    const { state, remote } = backend();
    const transport = remote();
    state.afterSessionRead = () => transport.dispose();
    await expect(transport.load()).rejects.toThrow("session has closed");
    expect(state.calls).toHaveLength(0);
  });
});

describe("server-backed review sessions", () => {
  test("disposal cancels debounced work, clears subscribers and blocks later calls", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore();
    let notifications = 0;
    current.subscribe(() => { notifications++; });
    current.start(base, "hash"); current.changeSource(`${base}!`);
    const beforeDispose = notifications;
    current.dispose(); current.dispose();
    await new Promise(resolve => setTimeout(resolve, 300));
    await current.refresh();
    expect(state.row).toBeNull();
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(0);
    expect(notifications).toBe(beforeDispose);
    await expect(current.keep()).rejects.toThrow("session has closed");
    expect(() => current.changeSource("another" )).toThrow("session has closed");
  });

  test("a queued write cannot run as another account even without disposal", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); current.start(base, "hash");
    current.changeSource(`${base}!`);
    state.activeUserId = crypto.randomUUID();
    await expect(current.keep()).rejects.toThrow("signed-in account changed");
    expect(state.row).toBeNull();
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(0);
    current.dispose();
  });

  test("an in-flight acknowledgement settles after disposal without dispatching queued newer edits", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); current.start(base, "hash");
    current.changeSource(`${base}!`);
    let committed!: () => void, release!: () => void;
    const atCommit = new Promise<void>(resolve => { committed = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    state.afterCommit = async () => { committed(); await pending; };
    const saving = current.keep();
    await atCommit;
    current.changeSource(`${base}!!`);
    current.dispose();
    release();
    await expect(saving).rejects.toThrow("not been saved");
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(1);
    expect(proposedSource(state.row!.payload)).toBe(`${base}!`);
  });

  test("an already committed decision acknowledges without calling an obsolete workspace callback", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); await current.importBundle(bundle(), base, "hash");
    let committed!: () => void, release!: () => void;
    const atCommit = new Promise<void>(resolve => { committed = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    state.afterCommit = async () => { await current.refresh(); committed(); await pending; };
    let callbacks = 0;
    const deciding = current.acceptShared(null, async () => true, async () => { callbacks++; });
    await atCommit;
    const reads = state.calls.filter(call => call.name === "get_note_review").length;
    current.dispose(); release();
    await deciding;
    expect(state.fileWrites).toBe(1);
    expect(callbacks).toBe(0);
    expect(state.calls.filter(call => call.name === "get_note_review")).toHaveLength(reads);
  });

  test("requires a successful fresh load, with no local fallback while offline", async () => {
    const { state, session } = backend();
    const current = session();
    expect(current.snapshot()).toMatchObject({ durability: "server", ready: false, kept: false });
    expect(() => current.start(base, "hash")).toThrow("Load the shared review");
    state.unavailable = true;
    await current.restore();
    expect(current.snapshot()).toMatchObject({ ready: false, loading: false, review: null, kept: false });
    await expect(current.importBundle(bundle(), base, "hash")).rejects.toThrow("Load the shared review");
    await expect(current.keep()).rejects.toThrow("Load the shared review");
    state.unavailable = false;
    await current.refresh();
    expect(current.snapshot()).toMatchObject({ ready: true, error: null });
  });

  test("an imported review recovers in a new browser identity from server state only", async () => {
    const { state, session } = backend();
    const first = session();
    await first.restore();
    await first.importBundle(bundle(), base, await contentToken(base));
    expect(state.file.content).toBe(base);
    const another = session();
    await another.restore();
    expect(another.snapshot()).toMatchObject({ durability: "server", ready: true, kept: true, baseRevision: await contentToken(base) });
    expect(another.snapshot().document?.text).toBe("A middle Z");
    expect(another.snapshot().review?.provenance).toEqual(bundle().provenance);
    expect(another.snapshot().sharedReview?.file_id).toBe(fileId);
    const reads = state.calls.length;
    await another.refresh();
    expect(state.calls.length).toBe(reads + 1);
  });

  test("read-only recovery performs no writes and status refresh preserves editor identity", async () => {
    const { state, session } = backend();
    const owner = session(); await owner.restore(); await owner.importBundle(bundle(), base, "hash");
    const reader = session(); await reader.restore();
    const document = reader.snapshot().document;
    const writes = state.calls.filter(call => call.name !== "get_note_review").length;
    await reader.refresh();
    expect(reader.snapshot().document).toBe(document);
    expect(state.calls.filter(call => call.name !== "get_note_review")).toHaveLength(writes);
  });

  test("typing coalesces pending snapshots and keep waits for a confirmed server save", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); current.start(base, "hash");
    current.changeSource(`${base}!`); current.changeSource(`${base}!!`);
    expect(current.snapshot().kept).toBe(false);
    expect(state.row).toBeNull();
    await current.keep();
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(1);
    expect(proposedSource(state.row!.payload)).toBe(`${base}!!`);
    expect(current.snapshot().kept).toBe(true);
  });

  test("lost save responses replay the original request before sending newer typing", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); current.start(base, "hash");
    current.changeSource(`${base}!`); state.loseSaveResponse = true;
    await expect(current.keep()).rejects.toThrow("could not be reached");
    current.changeSource(`${base}!!`);
    await current.keep();
    const calls = state.calls.filter(call => call.name === "save_note_review");
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(state.row?.version).toBe(2);
    expect(proposedSource(state.row!.payload)).toBe(`${base}!!`);
  });

  test("own-save signals before the success reply defer refresh without a false conflict", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore();
    state.afterCommit = async () => { await current.refresh(); };
    current.start(base, "hash");
    current.changeSource(`${base}!`);
    await current.keep();
    await current.refresh();
    expect(current.snapshot().error).toBeNull();
    expect(current.snapshot().kept).toBe(true);
    expect(current.snapshot().document?.text).toBe(`${base}!`);
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(1);
  });

  test("a newer cloud review cannot overwrite pending local candidate text", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); await current.importBundle(bundle(), base, "hash");
    current.changeSource("A middle Z!");
    state.row = { ...state.row!, version: state.row!.version + 1 };
    await current.refresh();
    expect(current.snapshot().document?.text).toBe("A middle Z!");
    expect(current.snapshot().error).toContain("changed while you were editing");
    await expect(current.keep()).rejects.toThrow("changed");
    expect(current.snapshot().kept).toBe(false);
  });

  test("explicit reload discards a pending candidate only after the user chooses cloud recovery", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); await current.importBundle(bundle(), base, "hash");
    current.changeSource("A middle Z!");
    state.row = { ...state.row!, version: state.row!.version + 1 };
    await current.reloadShared();
    expect(current.snapshot().document?.text).toBe("A middle Z");
    expect(current.snapshot()).toMatchObject({ kept: true, error: null, sharedReview: { version: 2 } });
    const writes = state.calls.filter(call => call.name === "save_note_review").length;
    await current.keep();
    expect(state.calls.filter(call => call.name === "save_note_review")).toHaveLength(writes);
  });

  test("acceptance is atomic on the server, cancellation is inert and completion retains original provenance", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); await current.importBundle(bundle(), base, "hash");
    let ordinaryWrites = 0;
    await expect(current.accept(null, async () => { ordinaryWrites++; return "unexpected"; })).rejects.toThrow("atomically");
    await current.acceptShared("first", async () => false, async () => { throw new Error("Canceled"); });
    expect(state.fileWrites).toBe(0);
    expect(ordinaryWrites).toBe(0);
    let refreshed = "";
    await current.acceptShared("first", async (next, old) => { expect(old).toBe(base); expect(next).toBe("A middle omega"); return true; }, async file => { refreshed = file.content; });
    expect(refreshed).toBe("A middle omega");
    expect(state.fileWrites).toBe(1);
    expect(current.snapshot().sharedReview?.base_version).toBe(2);
    await current.reject(null);
    expect(state.fileWrites).toBe(1);
    await current.stop();
    expect(current.snapshot()).toMatchObject({ review: null, completedReview: { status: "closed", original_bundle: { provenance: bundle().provenance } } });
    const another = session(); await another.restore();
    expect(another.snapshot().review).toBeNull();
    expect(another.snapshot().completedReview?.original_bundle).toEqual({ base, suggestions: bundle().suggestions, provenance: bundle().provenance });
  });

  test("finishing a newly started empty review flushes its creation before closing", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore();
    current.start(base, "hash");
    await current.stop();
    expect(state.row?.status).toBe("closed");
    expect(current.snapshot()).toMatchObject({ kept: true, review: null, completedReview: { status: "closed" } });
    expect(state.calls.filter(call => call.name !== "get_note_review").map(call => call.name)).toEqual(["save_note_review", "finish_note_review"]);
  });

  test("lost atomic-decision replies retry one mutation and failed canonical refresh never rewrites the file", async () => {
    const { state, session } = backend();
    const current = session(); await current.restore(); await current.importBundle(bundle(), base, "hash");
    state.loseDecisionResponse = true;
    await expect(current.acceptShared(null, async () => true, async () => {})).rejects.toThrow("could not be reached");
    await expect(current.acceptShared(null, async () => true, async () => { throw new Error("Cache refresh failed"); })).rejects.toThrow("Cache refresh failed");
    const calls = state.calls.filter(call => call.name === "decide_note_review");
    expect(calls[0].args).toEqual(calls[1].args);
    expect(state.fileWrites).toBe(1);
    expect(current.snapshot().review?.suggestions).toHaveLength(0);
    expect(current.snapshot().kept).toBe(true);
    await current.acceptShared(null, async () => true, async () => {});
    expect(state.fileWrites).toBe(1);
  });
});
