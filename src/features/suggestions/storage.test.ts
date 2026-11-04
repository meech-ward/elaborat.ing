import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  loadReviewDraft,
  MAX_REVIEW_DRAFT_BYTES,
  MAX_REVIEW_SOURCE_BYTES,
  MAX_REVIEW_SUGGESTIONS,
  reviewDraftStorageKey,
  ReviewDraftConflictError,
  ReviewDraftStorageError,
  saveReviewDraft,
  type ReviewDraft,
} from "./storage"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    get length() { return values.size },
    clear() { values.clear() },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

function serialLocks() {
  const calls: string[] = []
  const pending = new Map<string, Promise<unknown>>()
  return {
    calls,
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      calls.push(name)
      const next = (pending.get(name) ?? Promise.resolve()).then(callback)
      pending.set(name, next.catch(() => {}))
      return next
    },
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
let storage: ReturnType<typeof memoryStorage>
let locks: ReturnType<typeof serialLocks>

beforeEach(() => {
  storage = memoryStorage()
  locks = serialLocks()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "localStorage")
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator)
  else Reflect.deleteProperty(globalThis, "navigator")
})

const scope = '["https://backend.test","account-a","project-a"]'
const file = "file-id"
const draft = (): ReviewDraft => ({
  baseRevision: "saved-content-hash",
  base: "Hello world.\n",
  suggestions: [{ id: "suggestion-one", from: 6, to: 11, expected: "world", insert: "team" }],
})

test("reload recovers the exact review basis and pending edits without touching ordinary file storage", async () => {
  storage.setItem("ordinary-file-draft", "unsaved canonical edits")
  expect(loadReviewDraft(scope, file)).toBeNull()
  const saved = await saveReviewDraft(scope, file, draft(), null)
  expect(saved).toMatchObject(draft())
  expect(saved?.token).toBeString()
  expect(loadReviewDraft(scope, file)).toEqual(saved)
  expect(storage.getItem("ordinary-file-draft")).toBe("unsaved canonical edits")
  expect(locks.calls).toEqual([reviewDraftStorageKey(scope, file)])
})

test("saves copy the caller's state before awaiting a lock", async () => {
  const value = draft()
  const saving = saveReviewDraft(scope, file, value, null)
  value.suggestions[0].insert = "a later edit"
  expect((await saving)?.suggestions[0].insert).toBe("team")
})

test("a new token rejects stale updates and stale clears without losing the newer proposal", async () => {
  const first = (await saveReviewDraft(scope, file, draft(), null))!
  const next = { ...draft(), suggestions: [{ ...draft().suggestions[0], insert: "friends" }] }
  const second = (await saveReviewDraft(scope, file, next, first.token))!
  expect(second.token).not.toBe(first.token)
  await expect(saveReviewDraft(scope, file, draft(), first.token)).rejects.toBeInstanceOf(ReviewDraftConflictError)
  await expect(saveReviewDraft(scope, file, null, first.token)).rejects.toBeInstanceOf(ReviewDraftConflictError)
  expect(loadReviewDraft(scope, file)).toEqual(second)
  expect(await saveReviewDraft(scope, file, null, second.token)).toBeNull()
  expect(loadReviewDraft(scope, file)).toBeNull()
})

test("simultaneous tabs acquire the same lock and only one can replace the observed version", async () => {
  const results = await Promise.allSettled([
    saveReviewDraft(scope, file, draft(), null),
    saveReviewDraft(scope, file, { ...draft(), baseRevision: "another revision" }, null),
  ])
  expect(results[0].status).toBe("fulfilled")
  expect(results[1].status).toBe("rejected")
  if (results[1].status === "rejected") expect(results[1].reason).toBeInstanceOf(ReviewDraftConflictError)
  expect(loadReviewDraft(scope, file)?.baseRevision).toBe("saved-content-hash")
  expect(locks.calls[0]).toBe(locks.calls[1])
})

test("backend, account, project and file identity partition saved proposals without delimiter collisions", async () => {
  const variants = [
    [scope, file],
    ['["https://other-backend.test","account-a","project-a"]', file],
    ['["https://backend.test","account-b","project-a"]', file],
    ['["https://backend.test","account-a","project-b"]', file],
    [scope, "another-file"],
    ["a:b", "c"],
    ["a", "b:c"],
  ] as const
  const tokens = []
  for (const [partition, id] of variants) tokens.push((await saveReviewDraft(partition, id, draft(), null))!.token)
  expect(storage.values.size).toBe(variants.length)
  for (let i = 0; i < variants.length; i++) expect(loadReviewDraft(variants[i][0], variants[i][1])?.token).toBe(tokens[i])
})

test("unknown versions, malformed records and invalid source patches remain recoverable instead of being overwritten", async () => {
  const saved = await saveReviewDraft(scope, file, draft(), null)
  const key = reviewDraftStorageKey(scope, file)
  const original = storage.getItem(key)!
  const corruptions = [
    "{bad json",
    JSON.stringify({ ...JSON.parse(original), version: 2 }),
    JSON.stringify({ ...JSON.parse(original), extra: "unexpected" }),
    JSON.stringify({ ...JSON.parse(original), token: "not-a-token" }),
    JSON.stringify({ ...JSON.parse(original), draft: { ...draft(), extra: true } }),
    JSON.stringify({ ...JSON.parse(original), draft: { ...draft(), suggestions: [{ ...draft().suggestions[0], expected: "other" }] } }),
    JSON.stringify({ ...JSON.parse(original), draft: { ...draft(), suggestions: [{ ...draft().suggestions[0], to: 1000 }] } }),
    JSON.stringify({ ...JSON.parse(original), draft: { ...draft(), suggestions: [draft().suggestions[0], draft().suggestions[0]] } }),
  ]
  for (const raw of corruptions) {
    storage.setItem(key, raw)
    expect(() => loadReviewDraft(scope, file)).toThrow(ReviewDraftStorageError)
    await expect(saveReviewDraft(scope, file, draft(), saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
    expect(storage.getItem(key)).toBe(raw)
  }
})

test("UTF-16 emoji ranges survive reload and a range that splits a surrogate pair is refused", async () => {
  const value = { baseRevision: "emoji", base: "A 😀 face", suggestions: [{ id: "emoji", from: 2, to: 4, expected: "😀", insert: "🙂" }] }
  const saved = await saveReviewDraft(scope, file, value, null)
  expect(loadReviewDraft(scope, file)).toEqual(saved)
  const invalid = { ...value, suggestions: [{ ...value.suggestions[0], from: 3, expected: "\ude00" }] }
  await expect(saveReviewDraft(scope, file, invalid, saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(loadReviewDraft(scope, file)).toEqual(saved)
})

test("source limits count UTF-8 bytes for both the basis and proposed text", async () => {
  const oversized = "é".repeat(MAX_REVIEW_SOURCE_BYTES / 2 + 1)
  await expect(saveReviewDraft(scope, file, { baseRevision: "large", base: oversized, suggestions: [] }, null)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  const inserted = { ...draft(), suggestions: [{ ...draft().suggestions[0], insert: oversized }] }
  await expect(saveReviewDraft(scope, file, inserted, null)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(storage.values.size).toBe(0)
})

test("serialized records and suggestion counts are bounded before they can replace a recoverable draft", async () => {
  const saved = await saveReviewDraft(scope, file, draft(), null)
  const base = "a".repeat(MAX_REVIEW_SOURCE_BYTES)
  await expect(saveReviewDraft(scope, file, {
    baseRevision: "large",
    base,
    suggestions: [{ id: "whole-file", from: 0, to: base.length, expected: base, insert: "b".repeat(MAX_REVIEW_SOURCE_BYTES) }],
  }, saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  await expect(saveReviewDraft(scope, file, {
    ...draft(), suggestions: Array.from({ length: MAX_REVIEW_SUGGESTIONS + 1 }, () => draft().suggestions[0]),
  }, saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(loadReviewDraft(scope, file)).toEqual(saved)
  const key = reviewDraftStorageKey(scope, file)
  storage.setItem(key, " ".repeat(MAX_REVIEW_DRAFT_BYTES + 1))
  expect(() => loadReviewDraft(scope, file)).toThrow(ReviewDraftStorageError)
})

test("quota failures and refused clears report failure while retaining the last saved proposal", async () => {
  const saved = await saveReviewDraft(scope, file, draft(), null)
  const original = storage.getItem(reviewDraftStorageKey(scope, file))
  storage.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError") }
  await expect(saveReviewDraft(scope, file, { ...draft(), baseRevision: "new" }, saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(storage.getItem(reviewDraftStorageKey(scope, file))).toBe(original)
  storage.removeItem = () => { throw new Error("Storage disabled") }
  await expect(saveReviewDraft(scope, file, null, saved!.token)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(loadReviewDraft(scope, file)).toEqual(saved)
})

test("unavailable Web Locks, failed lock acquisition and blocked storage never report a successful save", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} })
  await expect(saveReviewDraft(scope, file, draft(), null)).rejects.toThrow("Web Locks")
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: () => Promise.reject(new Error("Lock refused")) } } })
  await expect(saveReviewDraft(scope, file, draft(), null)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("Storage refused") } })
  expect(() => loadReviewDraft(scope, file)).toThrow(ReviewDraftStorageError)
  await expect(saveReviewDraft(scope, file, draft(), null)).rejects.toBeInstanceOf(ReviewDraftStorageError)
  expect(storage.values.size).toBe(0)
})
