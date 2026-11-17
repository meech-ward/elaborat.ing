import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/mini";
import { ProjectPath } from "../project-storage/model";
import type { ReviewState } from "./review";
import { checkedReview, ReviewSchema } from "./validation";

const version = z.int().check(z.positive());
const ReviewRecord = z.object({
  id: z.uuid(), project_id: z.uuid(), file_id: z.uuid(), path: ProjectPath,
  base_version: version, version, status: z.enum(["open", "closed"]),
  payload: ReviewSchema, original_bundle: ReviewSchema,
  created_by: z.nullable(z.uuid()), updated_by: z.nullable(z.uuid()), created_at: z.string(), updated_at: z.string(), closed_at: z.nullable(z.string()),
});
const AcceptedFile = z.object({ id: z.uuid(), path: ProjectPath, version, content: z.string() });
export type SharedReviewRecord = z.infer<typeof ReviewRecord>;
export type SharedReviewFile = z.infer<typeof AcceptedFile>;
export type SharedReviewDecision = { review: SharedReviewRecord; file: SharedReviewFile | null };

export class SharedReviewError extends Error {
  override name = "SharedReviewError";
  constructor(readonly kind: "conflict" | "access" | "network" | "invalid", message: string) { super(message); }
}

/** Server persistence is explicit. It never reads or falls back to a browser sidecar. */
export interface SharedReviewPersistence {
  readonly kind: "server";
  dispose?(): void;
  load(): Promise<SharedReviewRecord | null>;
  save(payload: ReviewState, current: SharedReviewRecord | null, mutationId: string): Promise<SharedReviewRecord>;
  decide(current: SharedReviewRecord, decision: "accept" | "reject", suggestionId: string | null, mutationId: string): Promise<SharedReviewDecision>;
  finish(current: SharedReviewRecord, mutationId: string): Promise<SharedReviewRecord>;
}

export type SharedReviewContext = { userId: string; projectId: string; fileId: string; baseVersion: number };

/** Uses the signed-in user's ordinary client, so every request is subject to RLS and RPC role checks. */
export class SupabaseReviewRemote implements SharedReviewPersistence {
  readonly kind = "server" as const;
  private creatingId: string | null = null;
  private disposed = false;

  constructor(private readonly client: Pick<SupabaseClient, "auth" | "rpc">, private readonly context: SharedReviewContext) {
    z.object({ userId: z.uuid(), projectId: z.uuid(), fileId: z.uuid(), baseVersion: version }).parse(context);
  }

  dispose(): void { this.disposed = true; }

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let answer;
    try {
      if (this.disposed) throw new SharedReviewError("access", "This review session has closed. Reopen the note before changing its suggestions.");
      const { data: { session }, error } = await this.client.auth.getSession();
      if (error) throw new SharedReviewError(!error.status || error.status >= 500 ? "network" : "access", "Could not check the signed-in account for this review. Try again.");
      if (this.disposed) throw new SharedReviewError("access", "This review session has closed. Reopen the note before changing its suggestions.");
      if (!session || session.user.id !== this.context.userId)
        throw new SharedReviewError("access", "The signed-in account changed. Reopen the note before changing its suggestions.");
      // The global client's auth may change while fetch waits. This one request
      // keeps the checked account's bearer, just as project-category writes do.
      answer = await this.client.rpc(name, args).setHeader("Authorization", `Bearer ${session.access_token}`);
    } catch (error) {
      if (error instanceof SharedReviewError) throw error;
      throw new SharedReviewError("network", "The shared review could not be reached. Keep this tab open and retry saving, or export the review.");
    }
    if (answer.error) {
      const code = answer.error.code;
      if (code === "40001") throw new SharedReviewError("conflict", "This review or its saved file changed. Export your review before reloading the shared version.");
      if (code === "42501" || code === "403" || code === "55000") throw new SharedReviewError("access", "This shared review cannot be changed with your current access or project state.");
      throw new SharedReviewError("invalid", "The shared review request was refused. Your proposed text is still available for export.");
    }
    return answer.data;
  }

  private checked(value: unknown): SharedReviewRecord {
    try {
      const record = ReviewRecord.parse(value);
      checkedReview(record.payload);
      checkedReview(record.original_bundle);
      if (record.project_id !== this.context.projectId || record.file_id !== this.context.fileId)
        throw new Error("Unexpected shared review identity");
      return record;
    } catch { throw new SharedReviewError("invalid", "The shared review response could not be verified. No browser copy was substituted."); }
  }

  private response(value: unknown): SharedReviewRecord {
    return this.checked(z.object({ review: z.unknown() }).parse(value).review);
  }

  async load(): Promise<SharedReviewRecord | null> {
    const result = z.object({ review: z.nullable(z.unknown()) }).parse(await this.rpc("get_note_review", {
      project_id: this.context.projectId, file_id: this.context.fileId,
    }));
    return result.review === null ? null : this.checked(result.review);
  }

  async save(payload: ReviewState, current: SharedReviewRecord | null, mutationId: string): Promise<SharedReviewRecord> {
    const checked = checkedReview(payload);
    this.creatingId ??= current ? null : crypto.randomUUID();
    const reviewId = current?.id ?? this.creatingId;
    const record = this.response(await this.rpc("save_note_review", {
      project_id: this.context.projectId, file_id: this.context.fileId,
      review_id: reviewId, expected_version: current?.version ?? null,
      base_version: current?.base_version ?? this.context.baseVersion,
      mutation_id: z.uuid().parse(mutationId), payload: checked,
    }));
    if (record.id !== reviewId || record.status !== "open" || record.version !== (current?.version ?? 0) + 1)
      throw new SharedReviewError("invalid", "The saved shared review identity or version could not be verified.");
    this.creatingId = null;
    return record;
  }

  async decide(current: SharedReviewRecord, decision: "accept" | "reject", suggestionId: string | null, mutationId: string): Promise<SharedReviewDecision> {
    this.checked(current);
    const result = z.object({ review: z.unknown(), file: z.nullable(AcceptedFile) }).parse(await this.rpc("decide_note_review", {
      project_id: this.context.projectId, review_id: current.id, expected_version: current.version,
      mutation_id: z.uuid().parse(mutationId), decision, suggestion_id: suggestionId,
    }));
    if (result.file && result.file.id !== this.context.fileId) throw new SharedReviewError("invalid", "The accepted file identity could not be verified.");
    if ((decision === "accept") !== Boolean(result.file)) throw new SharedReviewError("invalid", "The review decision returned an unexpected file result.");
    const record = this.checked(result.review);
    if (record.id !== current.id || record.version !== current.version + 1 || record.status !== "open" ||
        (result.file && (result.file.version !== record.base_version || result.file.content !== record.payload.base || result.file.path !== record.path)))
      throw new SharedReviewError("invalid", "The review decision identity or version could not be verified.");
    return { review: record, file: result.file };
  }

  async finish(current: SharedReviewRecord, mutationId: string): Promise<SharedReviewRecord> {
    this.checked(current);
    const record = this.response(await this.rpc("finish_note_review", {
      project_id: this.context.projectId, review_id: current.id, expected_version: current.version, mutation_id: z.uuid().parse(mutationId),
    }));
    if (record.status !== "closed" || record.id !== current.id || record.version !== current.version + 1)
      throw new SharedReviewError("invalid", "The review was not confirmed finished.");
    return record;
  }
}
