import { createDocumentStore, type StoreState } from "@/lib/documentStore";
import type { DocumentFormat, SourcePatch } from "../document";
import { acceptReviewSuggestion, applyReviewPatches, createReview, proposedSource, rejectReviewSuggestion, replaceReviewSource, type ReviewState } from "./review";
import { loadReviewDraft, saveReviewDraft, type ReviewDraft } from "./storage";

export type LocalReviewSnapshot = {
  review: ReviewState | null;
  document: StoreState | null;
  baseRevision: string | null;
  busy: boolean;
  keeping: boolean;
  kept: boolean;
  error: string | null;
};

type Persistence = {
  load: typeof loadReviewDraft;
  save: typeof saveReviewDraft;
};

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
  private requested: { record: ReviewDraft | null; generation: number } | null = null;
  private keeping: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private document: StoreState | null = null;
  private current: LocalReviewSnapshot;

  constructor(
    readonly scope: string,
    readonly fileKey: string,
    readonly path: string,
    private format: DocumentFormat,
    private persistence: Persistence = { load: loadReviewDraft, save: saveReviewDraft },
  ) {
    this.buffer = createDocumentStore("", format);
    this.current = this.value();
  }

  snapshot = (): LocalReviewSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

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
      baseRevision: this.baseRevision, busy: this.busy, keeping: this.keeping !== null,
      kept: this.generation === this.keptGeneration, error: this.error };
  }

  private publish(): void {
    this.current = this.value();
    for (const listener of this.listeners) listener();
  }

  restore(): void {
    if (this.review || this.busy) return;
    try {
      const saved = this.persistence.load(this.scope, this.fileKey);
      if (!saved) return;
      const review = { base: saved.base, suggestions: saved.suggestions };
      const source = proposedSource(review);
      this.token = saved.token;
      this.baseRevision = saved.baseRevision;
      this.review = review;
      this.desired = { ...review, baseRevision: saved.baseRevision };
      this.buffer.replaceDocument(source, this.format);
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  start(base: string, baseRevision: string): void {
    if (this.review || this.busy) throw new Error("A local review is already open.");
    // Never overwrite a review another tab created since this file opened.
    const saved = this.persistence.load(this.scope, this.fileKey);
    if (saved) { this.restore(); return; }
    this.baseRevision = baseRevision;
    this.review = createReview(base);
    this.buffer.replaceDocument(base, this.format);
    this.queueKeep();
  }

  private editable(): ReviewState {
    if (!this.review || this.busy) throw new Error("This local review cannot change right now.");
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

  reject(id: string | null): void {
    const review = this.editable();
    this.review = id === null ? createReview(review.base) : rejectReviewSuggestion(review, id);
    // Decisions end the typing history: Undo must not restore a rejected proposal.
    this.buffer.replaceDocument(proposedSource(this.review), this.format);
    this.queueKeep();
  }

  async accept(id: string | null, commit: (next: string, base: string, revision: string) => Promise<string | null>): Promise<void> {
    const review = this.editable();
    if (!review.suggestions.length || this.baseRevision === null) return;
    this.busy = true;
    this.publish();
    try {
      await this.keep();
      const next = id === null ? createReview(proposedSource(review)) : acceptReviewSuggestion(review, id);
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
    }
  }

  async stop(): Promise<void> {
    if (this.editable().suggestions.length) throw new Error("Accept or reject the remaining suggestions first.");
    this.busy = true;
    this.publish();
    try {
      this.queueKeep(null);
      await this.keep();
      this.review = null;
      this.baseRevision = null;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.publish();
  }

  private queueKeep(record?: ReviewDraft | null): void {
    const next = record === undefined ? (this.review && this.baseRevision ? { ...this.review, baseRevision: this.baseRevision } : null) : record;
    this.desired = next;
    this.requested = { record: next, generation: ++this.generation };
    this.drain();
  }

  private drain(): void {
    if (this.keeping) { this.publish(); return; }
    // Coalesce typing while a storage lock is pending, preserving the newest source.
    this.keeping = Promise.resolve().then(async () => {
      while (this.requested) {
        const request = this.requested;
        this.requested = null;
        const saved = await this.persistence.save(this.scope, this.fileKey, request.record, this.token);
        this.token = saved?.token ?? null;
        this.keptGeneration = request.generation;
        this.error = null;
      }
    }).catch(error => {
      this.requested = null;
      this.fail(error);
    }).finally(() => {
      this.keeping = null;
      // A subscriber or awaiting storage operation may have queued an edit
      // after the loop finished but before this promise settled.
      if (this.requested) this.drain();
      else this.publish();
    });
    this.publish();
  }

  async keep(): Promise<void> {
    if (this.generation !== this.keptGeneration && !this.keeping) {
      this.requested = { record: this.desired, generation: this.generation };
      this.drain();
    }
    // A finishing drain can hand off to another one. Follow it instead of
    // reporting failure while the newest queued source is still being kept.
    while (this.keeping) await this.keeping;
    if (this.generation !== this.keptGeneration) throw new Error(this.error ?? "These suggestions have not been kept in this browser.");
  }
}
