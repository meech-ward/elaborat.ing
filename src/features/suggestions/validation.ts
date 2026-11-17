import { z } from "zod/mini";
import { proposedSource, validateReview, type ReviewState } from "./review";

export const MAX_REVIEW_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_DRAFT_BYTES = 4 * 1024 * 1024;
export const MAX_REVIEW_SUGGESTIONS = 256;
export const MAX_REVIEW_ANNOTATIONS = 2048;

const bounded = (maximum: number) => z.string().check(z.maxLength(maximum));
const id = z.string().check(z.minLength(1), z.maxLength(256));
const offset = z.int().check(z.nonnegative());
const Annotation = z.strictObject({
  id,
  kind: z.string().check(z.minLength(1), z.maxLength(64)),
  sourceId: z.optional(id),
  author: z.optional(bounded(512)),
  date: z.optional(bounded(512)),
  text: z.optional(bounded(64 * 1024)),
  locator: z.optional(bounded(2048)),
  rawXml: z.optional(bounded(128 * 1024)),
  anchor: z.optional(z.strictObject({
    projection: z.enum(["base", "proposed", "docx-original", "docx-accepted", "docx-review"]),
    from: offset,
    to: offset,
    quote: z.optional(bounded(16 * 1024)),
  })),
});

export const ReviewFields = {
  base: bounded(MAX_REVIEW_SOURCE_BYTES),
  suggestions: z.array(z.strictObject({
    id,
    from: offset,
    to: offset,
    insert: bounded(MAX_REVIEW_SOURCE_BYTES),
    expected: bounded(MAX_REVIEW_SOURCE_BYTES),
    sourceIds: z.optional(z.array(id).check(z.maxLength(MAX_REVIEW_ANNOTATIONS))),
    edited: z.optional(z.literal(true)),
  })).check(z.maxLength(MAX_REVIEW_SUGGESTIONS)),
  provenance: z.optional(z.strictObject({
    label: z.string().check(z.minLength(1), z.maxLength(1024)),
    sourceSha256: z.optional(z.string().check(z.regex(/^[a-fA-F0-9]{64}$/))),
    base: z.optional(bounded(MAX_REVIEW_SOURCE_BYTES)),
    proposed: z.optional(bounded(MAX_REVIEW_SOURCE_BYTES)),
    annotations: z.array(Annotation).check(z.maxLength(MAX_REVIEW_ANNOTATIONS)),
  })),
};

export const ReviewSchema = z.strictObject(ReviewFields);
export const reviewByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Runs the same source and metadata boundary checks for portable files and browser recovery. */
export function checkedReview(value: unknown): ReviewState {
  const parsed = ReviewSchema.parse(value);
  validateReview(parsed);
  if (reviewByteLength(parsed.base) > MAX_REVIEW_SOURCE_BYTES ||
      reviewByteLength(proposedSource(parsed)) > MAX_REVIEW_SOURCE_BYTES ||
      [parsed.provenance?.base, parsed.provenance?.proposed].some(source => source !== undefined && reviewByteLength(source) > MAX_REVIEW_SOURCE_BYTES))
    throw new Error("Review source is larger than 2 MiB.");
  return parsed;
}
