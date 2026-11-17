import { createDocumentStore, type StoreState } from "@/lib/documentStore";
import type { DocumentFormat, SourcePatch } from "../document";
import { acceptReviewSuggestion, applyReviewPatches, createReview, proposedSource, rejectReviewSuggestion, replaceReviewSource, type ReviewState } from "./review";
import { loadReviewDraft, saveReviewDraft, type ReviewDraft } from "./storage";
import type { PortableReviewBundle } from "./portable";
import { contentToken } from "../project-storage/model";
import type { SharedReviewFile, SharedReviewPersistence, SharedReviewRecord } from "./remote";

export type LocalReviewSnapshot = {
  review: ReviewState | null;
  document: StoreState | null;
  baseRevision: string | null;
  busy: boolean;
  keeping: boolean;
  kept: boolean;
  error: string | null;
  durability: "browser" | "server";
  ready: boolean;
  loading: boolean;
  completedReview: SharedReviewRecord | null;
  sharedReview: SharedReviewRecord | null;
};

type Persistence = {
  load: typeof loadReviewDraft;
  save: typeof saveReviewDraft;
};
type KeepRequest = { record: ReviewDraft | null; generation: number; mutationId: string };

/** A review buffer has no file-writing authority. Only explicit acceptance calls commit. */
export class LocalReviewSession {
  private buffer;
  private review: ReviewState | null = null;
  private baseRevision: string | null = null;
  private token: string | null = null;
  private busy = false;
  private error: string | null = null;
  private generation = 0;
  private keptGeneration = 0;
  /** Includes an intentional removal, so retry never recreates a stopped draft. */
  private desired: ReviewDraft | null = null;
  private requested: KeepRequest | null = null;
  private failedRequest: KeepRequest | null = null;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  private keeping: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private document: StoreState | null = null;
  private current: LocalReviewSnapshot;
  private ready = true;
  private loading = false;
  private sharedRecord: SharedReviewRecord | null = null;
  private completedReview: SharedReviewRecord | null = null;
  private decisionAttempt: { key: string; mutationId: string } | null = null;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    readonly scope: string,
    readonly fileKey: string,
    readonly path: string,
    private format: DocumentFormat,
    private persistence: Persistence | SharedReviewPersistence = { load: loadReviewDraft, save: saveReviewDraft },
  ) {
    this.buffer = createDocumentStore("", format);
    this.ready = this.remote === null;
    this.current = this.value();
  }

  private get remote(): SharedReviewPersistence | null {
    return "kind" in this.persistence ? this.persistence : null;
  }

  private get browser(): Persistence {
    if (this.remote) throw new Error("Shared reviews cannot use browser persistence.");
    return this.persistence as Persistence;
  }

  snapshot = (): LocalReviewSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Cancel unsent work when its owning file/account session leaves. An already sent request may still acknowledge. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    this.requested = null;
    this.failedRequest = null;
    this.refreshAgain = false;
    this.listeners.clear();
    this.remote?.dispose?.();
  }

  private active(): void {
    if (this.disposed) throw new Error("This review session has closed. Reopen the note before changing its suggestions.");
  }

  private value(): LocalReviewSnapshot {
    const next = this.review ? this.buffer.snapshot() : null;
    if (next === null) this.document = null;
    else if (!this.document || next.text !== this.document.text || next.revision !== this.document.revision ||
        next.docId !== this.document.docId || next.format !== this.document.format || next.dirty !== this.document.dirty) {
      this.document = next;
    }
    // Keeping/error/busy changes have no new source. Retain that identity so
    // an asynchronous rendered projection is not invalidated by sidecar I/O.
    return { review: this.review, document: this.document,
      baseRevision: this.baseRevision, busy: this.busy, keeping: this.keeping !== null || this.keepTimer !== null,
      kept: this.ready && this.generation === this.keptGeneration, error: this.error,
      durability: this.remote ? "server" : "browser", ready: this.ready, loading: this.loading,
      completedReview: this.completedReview, sharedReview: this.sharedRecord };
  }

  private publish(): void {
    this.current = this.value();
    for (const listener of this.listeners) listener();
  }

  restore(): void | Promise<void> {
    if (this.disposed) return;
    if (this.review || this.busy) return;
    if (this.remote) return this.refresh();
    try {
      const saved = this.browser.load(this.scope, this.fileKey);
      if (!saved) return;
      const { baseRevision, token, ...review } = saved;
      const source = proposedSource(review);
      this.token = token;
      this.baseRevision = baseRevision;
      this.review = review;
      this.desired = { ...review, baseRevision };
      this.buffer.replaceDocument(source, this.format);
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Fresh cloud reads never replace an unsaved candidate or substitute a browser sidecar. */
  async refresh(): Promise<void> {
    const remote = this.remote;
    if (!remote || this.disposed) return;
    if (this.loading || this.busy || this.keeping) { this.refreshAgain = true; return; }
    const generation = this.generation;
    this.loading = true;
    this.publish();
    try {
      const record = await remote.load();
      if (this.disposed) return;
      const current = this.sharedRecord ?? this.completedReview;
      const same = record?.id === current?.id && record?.version === current?.version && record?.status === current?.status;
      if (this.busy || this.keeping || this.keepTimer || this.generation !== this.keptGeneration || generation !== this.generation) {
        if (!same) throw new Error("The shared review changed while you were editing. Export your review before reloading the shared version.");
        return;
      }
      if (!same || !this.ready) await this.installShared(record, generation);
      this.ready = true;
      this.error = null;
    } catch (error) {
      this.fail(error);
    } finally {
      this.loading = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  /** Only an explicit discard/reload action may replace an unkept candidate. */
  async reloadShared(): Promise<void> {
    this.active();
    const remote = this.remote;
    if (!remote) throw new Error("This note does not use shared reviews.");
    if (this.busy) throw new Error("Finish the current review decision before reloading.");
    this.busy = true;
    this.publish();
    try {
      if (this.keepTimer) clearTimeout(this.keepTimer);
      this.keepTimer = null;
      this.requested = null;
      while (this.keeping) await this.keeping;
      this.active();
      this.failedRequest = null;
      this.requested = null;
      await this.installShared(await remote.load());
      this.error = null;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  private async installShared(record: SharedReviewRecord | null, expectedGeneration?: number): Promise<void> {
    const review = record?.status === "open" ? record.payload : null;
    const baseRevision = review ? await contentToken(review.base) : null;
    if (expectedGeneration !== undefined && this.generation !== expectedGeneration)
      throw new Error("The shared review changed while you were editing. Export your review before reloading the shared version.");
    this.sharedRecord = record?.status === "open" ? record : null;
    this.completedReview = record?.status === "closed" ? record : null;
    this.review = review;
    this.baseRevision = baseRevision;
    this.token = record ? String(record.version) : null;
    this.desired = this.review && this.baseRevision ? { ...this.review, baseRevision: this.baseRevision } : null;
    if (this.review) this.buffer.replaceDocument(proposedSource(this.review), this.format);
    this.requested = null;
    this.failedRequest = null;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    this.keptGeneration = ++this.generation;
    this.ready = true;
  }

  private resumeRefresh(): void {
    if (this.disposed || !this.refreshAgain || this.loading || this.busy || this.keeping || this.keepTimer) return;
    this.refreshAgain = false;
    void this.refresh();
  }

  start(base: string, baseRevision: string): void {
    this.active();
    if (!this.ready || this.loading) throw new Error("Load the shared review before starting another.");
    if (this.review || this.busy) throw new Error(`A ${this.remote ? "shared" : "local"} review is already open.`);
    // Never overwrite a review another tab created since this file opened.
    const saved = this.remote ? null : this.browser.load(this.scope, this.fileKey);
    if (saved) { this.restore(); return; }
    this.baseRevision = baseRevision;
    this.review = createReview(base);
    this.buffer.replaceDocument(base, this.format);
    this.queueKeep();
  }

  /** The caller verifies edit permission, current saved bytes, identity and absence of a canonical draft. */
  async importBundle(value: PortableReviewBundle, base: string, baseRevision: string): Promise<void> {
    this.active();
    if (!this.ready || this.loading) throw new Error("Load the shared review before importing suggestions.");
    if (this.review || this.busy) throw new Error(`Finish the existing ${this.remote ? "shared" : "local"} review before importing another.`);
    const { checkedReviewBundle } = await import("./portable");
    this.active();
    if (this.review || this.busy) throw new Error(`Finish the existing ${this.remote ? "shared" : "local"} review before importing another.`);
    const bundle = checkedReviewBundle(value);
    if (bundle.path !== this.path) throw new Error("This review bundle belongs to a different note.");
    if (bundle.base !== base) throw new Error("The saved note does not match this review bundle's original source.");
    if (!baseRevision || baseRevision.length > 1024) throw new Error("Save the note before importing suggestions.");
    const existing = this.remote ? (await this.remote.load())?.status === "open" : this.browser.load(this.scope, this.fileKey);
    this.active();
    if (this.review || this.busy) throw new Error("Finish the existing review before importing another.");
    if (existing)
      throw new Error(`Another ${this.remote ? "shared" : "local"} review already exists for this note. Reload it before importing.`);
    const review: ReviewState = { base: bundle.base, suggestions: bundle.suggestions,
      ...(bundle.provenance ? { provenance: bundle.provenance } : {}) };
    this.baseRevision = baseRevision;
    this.review = review;
    this.buffer.replaceDocument(proposedSource(review), this.format);
    this.busy = true;
    try {
      this.queueKeep();
      await this.keep();
    } finally {
      // Failed imports remain exportable in memory, with the existing sidecar untouched.
      this.busy = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  private editable(): ReviewState {
    this.active();
    if (!this.review || this.busy) throw new Error(`This ${this.remote ? "shared" : "local"} review cannot change right now.`);
    return this.review;
  }

  changeSource(text: string, patches?: SourcePatch[]): void {
    const review = this.editable();
    if (text === this.buffer.snapshot().text) return;
    const next = patches === undefined ? replaceReviewSource(review, text) : applyReviewPatches(review, patches);
    if (proposedSource(next) !== text) throw new Error("Source changes do not match the proposed text.");
    this.review = next;
    this.buffer.setText(text);
    this.queueKeep();
  }

  applyPatches(revision: number, patches: SourcePatch[]): void {
    const review = this.editable();
    const next = applyReviewPatches(review, patches);
    this.buffer.applyPatches(revision, patches);
    if (next === review) return;
    this.review = next;
    this.queueKeep();
  }

  reject(id: string | null): void | Promise<void> {
    if (this.remote) return this.decideShared("reject", id);
    const review = this.editable();
    this.review = id === null ? { ...review, suggestions: [] } : rejectReviewSuggestion(review, id);
    // Decisions end the typing history: Undo must not restore a rejected proposal.
    this.buffer.replaceDocument(proposedSource(this.review), this.format);
    this.queueKeep();
  }

  async accept(id: string | null, commit: (next: string, base: string, revision: string) => Promise<string | null>): Promise<void> {
    if (this.remote) throw new Error("Shared suggestions must be accepted atomically on the server.");
    const review = this.editable();
    if (!review.suggestions.length || this.baseRevision === null) return;
    this.busy = true;
    this.publish();
    try {
      await this.keep();
      this.active();
      const next = id === null ? { ...review, base: proposedSource(review), suggestions: [] } : acceptReviewSuggestion(review, id);
      const revision = await commit(next.base, review.base, this.baseRevision);
      if (revision === null) return;
      this.review = next;
      this.baseRevision = revision;
      this.buffer.replaceDocument(proposedSource(next), this.format);
      this.queueKeep();
      await this.keep();
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  async acceptShared(
    id: string | null,
    beforeCommit: (next: string, base: string, revision: string) => Promise<boolean>,
    onAccepted: (file: SharedReviewFile) => Promise<void>,
  ): Promise<void> {
    return this.decideShared("accept", id, beforeCommit, onAccepted);
  }

  private async decideShared(
    decision: "accept" | "reject", id: string | null,
    beforeCommit?: (next: string, base: string, revision: string) => Promise<boolean>,
    onAccepted?: (file: SharedReviewFile) => Promise<void>,
  ): Promise<void> {
    const remote = this.remote;
    const review = this.editable();
    if (!remote) throw new Error("This note does not use shared reviews.");
    if (!review.suggestions.length || !this.baseRevision) return;
    this.busy = true;
    this.publish();
    try {
      await this.keep();
      this.active();
      const current = this.sharedRecord;
      if (!current) throw new Error("Save the shared review before deciding suggestions.");
      const next = decision === "accept" ? (id === null ? proposedSource(review) : acceptReviewSuggestion(review, id).base) : review.base;
      if (decision === "accept" && (!beforeCommit || !await beforeCommit(next, review.base, this.baseRevision))) return;
      this.active();
      const key = JSON.stringify([current.id, current.version, decision, id]);
      if (this.decisionAttempt?.key !== key) this.decisionAttempt = { key, mutationId: crypto.randomUUID() };
      const result = await remote.decide(current, decision, id, this.decisionAttempt.mutationId);
      await this.installShared(result.review);
      this.decisionAttempt = null;
      this.error = null;
      this.publish();
      // The server has committed already. A failed cache refresh must never retry the decision as a new write.
      if (result.file && onAccepted && !this.disposed) await onAccepted(result.file);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  async stop(): Promise<void> {
    if (this.editable().suggestions.length) throw new Error("Accept or reject the remaining suggestions first.");
    this.busy = true;
    this.publish();
    try {
      if (this.remote) await this.keep();
      this.active();
      this.queueKeep(null);
      await this.keep();
      this.review = null;
      this.baseRevision = null;
    } finally {
      this.busy = false;
      this.publish();
      this.resumeRefresh();
    }
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.publish();
  }

  private queueKeep(record?: ReviewDraft | null): void {
    this.active();
    const next = record === undefined ? (this.review && this.baseRevision ? { ...this.review, baseRevision: this.baseRevision } : null) : record;
    this.desired = next;
    this.requested = { record: next, generation: ++this.generation, mutationId: crypto.randomUUID() };
    if (this.remote && !this.keeping) {
      if (this.keepTimer) clearTimeout(this.keepTimer);
      this.keepTimer = setTimeout(() => { this.keepTimer = null; this.drain(); }, 250);
      this.publish();
    } else this.drain();
  }

  private async saveRequest(request: KeepRequest): Promise<{ token: string } | null> {
    this.active();
    const remote = this.remote;
    if (!remote) return this.browser.save(this.scope, this.fileKey, request.record, this.token);
    if (request.record === null) {
      if (!this.sharedRecord) throw new Error("No shared review is open to finish.");
      const record = await remote.finish(this.sharedRecord, request.mutationId);
      this.completedReview = record;
      this.sharedRecord = null;
      return null;
    }
    const payload: ReviewState = { base: request.record.base, suggestions: request.record.suggestions,
      ...(request.record.provenance ? { provenance: request.record.provenance } : {}) };
    const record = await remote.save(payload, this.sharedRecord, request.mutationId);
    this.sharedRecord = record;
    this.completedReview = null;
    return { token: String(record.version) };
  }

  private drain(): void {
    if (this.disposed) return;
    if (this.keeping) { this.publish(); return; }
    // Coalesce typing while a storage lock is pending, preserving the newest source.
    this.keeping = Promise.resolve().then(async () => {
      while (!this.disposed && (this.failedRequest || this.requested)) {
        const request = this.failedRequest ?? this.requested!;
        if (this.failedRequest) this.failedRequest = null;
        else this.requested = null;
        let saved;
        try { saved = await this.saveRequest(request); }
        catch (error) { if (this.remote && !this.disposed) this.failedRequest = request; throw error; }
        this.token = saved?.token ?? null;
        this.keptGeneration = request.generation;
        this.error = null;
      }
    }).catch(error => {
      if (!this.remote) this.requested = null;
      this.fail(error);
    }).finally(() => {
      this.keeping = null;
      // A subscriber or awaiting storage operation may have queued an edit
      // after the loop finished but before this promise settled.
      if (this.requested && !this.failedRequest) this.drain();
      else this.publish();
      this.resumeRefresh();
    });
    this.publish();
  }

  async keep(): Promise<void> {
    this.active();
    if (!this.ready) throw new Error("Load the shared review before saving suggestions.");
    if (this.keepTimer) { clearTimeout(this.keepTimer); this.keepTimer = null; }
    if (this.generation !== this.keptGeneration && !this.keeping) {
      if (!this.requested && !this.failedRequest) this.requested = { record: this.desired, generation: this.generation, mutationId: crypto.randomUUID() };
      this.drain();
    }
    // A finishing drain can hand off to another one. Follow it instead of
    // reporting failure while the newest queued source is still being kept.
    while (this.keeping) await this.keeping;
    if (this.generation !== this.keptGeneration) throw new Error(this.error ?? (this.remote ? "These suggestions have not been saved to the project." : "These suggestions have not been kept in this browser."));
  }
}
