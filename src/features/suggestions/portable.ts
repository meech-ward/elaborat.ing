import { z } from "zod/mini";
import { ProjectPath } from "../project-storage/model";
import type { ReviewState } from "./review";
import { checkedReview, MAX_REVIEW_DRAFT_BYTES, reviewByteLength, ReviewFields } from "./validation";

export type PortableReviewBundle = ReviewState & {
  format: "elaborating-review";
  version: 1;
  path: string;
};

export const MAX_REVIEW_BUNDLE_BYTES = MAX_REVIEW_DRAFT_BYTES;

const Bundle = z.strictObject({
  format: z.literal("elaborating-review"),
  version: z.literal(1),
  path: ProjectPath.check(z.refine(path => /\.mdx?$/i.test(path), "A review needs a Markdown or MDX note.")),
  ...ReviewFields,
});

/** A portable record contains source coordinates and provenance, never a browser/account identity. */
export function checkedReviewBundle(value: unknown): PortableReviewBundle {
  const parsed = Bundle.parse(value);
  checkedReview({ base: parsed.base, suggestions: parsed.suggestions,
    ...(parsed.provenance ? { provenance: parsed.provenance } : {}) });
  if (reviewByteLength(JSON.stringify(parsed)) > MAX_REVIEW_BUNDLE_BYTES)
    throw new Error("The review bundle is larger than 4 MiB.");
  return parsed;
}

export function parseReviewBundle(text: string): PortableReviewBundle {
  if (text.length > MAX_REVIEW_BUNDLE_BYTES || reviewByteLength(text) > MAX_REVIEW_BUNDLE_BYTES)
    throw new Error("The review bundle is larger than 4 MiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("This file is not a valid review bundle."); }
  try { return checkedReviewBundle(value); }
  catch (error) {
    throw new Error(`This review bundle could not be imported: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function serializeReviewBundle(path: string, state: ReviewState): string {
  const bundle = checkedReviewBundle({ format: "elaborating-review", version: 1, path,
    base: state.base, suggestions: state.suggestions,
    ...(state.provenance ? { provenance: state.provenance } : {}) });
  // Compact output leaves room for source records close to the browser's storage limit.
  return JSON.stringify(bundle);
}
