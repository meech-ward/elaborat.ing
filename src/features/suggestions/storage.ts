import { z } from "zod/mini"
import { proposedSource, validateReview, type ReviewSuggestion } from "./review"

export const MAX_REVIEW_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_REVIEW_DRAFT_BYTES = 4 * 1024 * 1024
export const MAX_REVIEW_SUGGESTIONS = 256

export type ReviewDraft = {
  baseRevision: string
  base: string
  suggestions: ReviewSuggestion[]
}

export type StoredReviewDraft = ReviewDraft & { token: string }

export class ReviewDraftStorageError extends Error {
  override name = "ReviewDraftStorageError"
}

export class ReviewDraftConflictError extends Error {
  override name = "ReviewDraftConflictError"

  constructor() {
    super("These suggestions changed in another tab. Export your proposed source before reloading.")
  }
}

const Patch = z.strictObject({
  id: z.string().check(z.minLength(1), z.maxLength(256)),
  from: z.int().check(z.nonnegative()),
  to: z.int().check(z.nonnegative()),
  insert: z.string().check(z.maxLength(MAX_REVIEW_SOURCE_BYTES)),
  expected: z.string().check(z.maxLength(MAX_REVIEW_SOURCE_BYTES)),
})

const Draft = z.strictObject({
  baseRevision: z.string().check(z.minLength(1), z.maxLength(1024)),
  base: z.string().check(z.maxLength(MAX_REVIEW_SOURCE_BYTES)),
  suggestions: z.array(Patch).check(z.maxLength(MAX_REVIEW_SUGGESTIONS)),
})

const Stored = z.strictObject({
  version: z.literal(1),
  token: z.uuid(),
  draft: Draft,
})

const encoder = new TextEncoder()
const recoveryMessage = "Your browser could not save these suggestions. Keep this tab open and export the proposed source."
const invalidMessage = "Saved suggestions could not be read. Export any proposed source still open before reloading."

/** Separate from ordinary file drafts, scoped to the backend, account and project. */
export function reviewDraftStorageKey(scope: string, fileKey: string): string {
  if (typeof scope !== "string" || scope.length < 1 || scope.length > 4096 ||
      typeof fileKey !== "string" || fileKey.length < 1 || fileKey.length > 2048) {
    throw new ReviewDraftStorageError("Suggestions need a valid project and file identity.")
  }
  return `elaborating:review-draft:v1:${JSON.stringify([scope, fileKey])}`
}

function browserStorage(): Storage {
  try {
    if (typeof localStorage !== "undefined") return localStorage
  } catch { /* Some browsers throw when accessing storage itself. */ }
  throw new ReviewDraftStorageError("Your browser could not access saved suggestions.")
}

function browserLocks(): LockManager {
  try {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks
    }
  } catch { /* Access can be refused even when the property exists. */ }
  throw new ReviewDraftStorageError("This browser cannot safely save suggestions across tabs. Use a browser with Web Locks.")
}

function checkedDraft(value: unknown): ReviewDraft {
  const parsed = Draft.safeParse(value)
  if (!parsed.success) throw new ReviewDraftStorageError(invalidMessage)
  try {
    validateReview(parsed.data)
    if (encoder.encode(parsed.data.base).byteLength > MAX_REVIEW_SOURCE_BYTES ||
        encoder.encode(proposedSource(parsed.data)).byteLength > MAX_REVIEW_SOURCE_BYTES) {
      throw new Error("Review source is too large")
    }
  } catch {
    throw new ReviewDraftStorageError(invalidMessage)
  }
  return parsed.data
}

function readStored(storage: Storage, key: string): StoredReviewDraft | null {
  let raw: string | null
  try { raw = storage.getItem(key) }
  catch { throw new ReviewDraftStorageError("Your browser could not read saved suggestions.") }
  if (raw === null) return null
  if (raw.length > MAX_REVIEW_DRAFT_BYTES || encoder.encode(raw).byteLength > MAX_REVIEW_DRAFT_BYTES) {
    throw new ReviewDraftStorageError(invalidMessage)
  }
  let stored: z.infer<typeof Stored>
  try {
    const parsed = Stored.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new Error("Invalid saved suggestions")
    stored = parsed.data
  } catch {
    throw new ReviewDraftStorageError(invalidMessage)
  }
  return { ...checkedDraft(stored.draft), token: stored.token }
}

/** Invalid records are kept intact, so reading cannot erase recoverable work. */
export function loadReviewDraft(scope: string, fileKey: string): StoredReviewDraft | null {
  return readStored(browserStorage(), reviewDraftStorageKey(scope, fileKey))
}

/**
 * The Web Lock makes the token check and write atomic across cooperating tabs.
 * A missing lock, stale token or storage failure is reported to the caller.
 */
export async function saveReviewDraft(
  scope: string,
  fileKey: string,
  record: ReviewDraft | null,
  expectedToken: string | null,
): Promise<StoredReviewDraft | null> {
  const key = reviewDraftStorageKey(scope, fileKey)
  const locks = browserLocks()
  const storage = browserStorage()
  const draft = record === null ? null : checkedDraft(record)

  try {
    return await locks.request(key, () => {
      const current = readStored(storage, key)
      if ((current?.token ?? null) !== expectedToken) throw new ReviewDraftConflictError()
      if (draft === null) {
        storage.removeItem(key)
        return null
      }
      const token = crypto.randomUUID()
      const raw = JSON.stringify({ version: 1, token, draft })
      if (encoder.encode(raw).byteLength > MAX_REVIEW_DRAFT_BYTES) {
        throw new ReviewDraftStorageError("These suggestions are too large to keep in this browser. Export the proposed source.")
      }
      storage.setItem(key, raw)
      return { ...draft, token }
    })
  } catch (error) {
    if (error instanceof ReviewDraftConflictError || error instanceof ReviewDraftStorageError) throw error
    throw new ReviewDraftStorageError(recoveryMessage)
  }
}
