import { z } from "zod/mini"

/** A category is a flat home-page filter, never a path or an access grant. */
export const categorySelectionSchema = z.catch(z.optional(z.union([z.literal("all"), z.literal("uncategorized"), z.uuid()])), undefined)

export function categorySelection(value: unknown): string | undefined {
  return categorySelectionSchema.parse(value)?.toLowerCase()
}
