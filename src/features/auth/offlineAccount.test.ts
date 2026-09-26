import { expect, test } from "bun:test"
import { forgetOfflineAccount, readOfflineAccount, rememberOfflineAccount } from "./offlineAccount"

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  }
}

const account = { userId: "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01", email: "person@example.com", supabaseUrl: "https://abc.supabase.co" }

test("the last account signed in is remembered until sign-out", () => {
  const storage = memoryStorage()
  rememberOfflineAccount(account, storage)
  expect(readOfflineAccount(storage)).toEqual({ version: 1, ...account })
  forgetOfflineAccount(storage)
  expect(readOfflineAccount(storage)).toBeNull()
})

test("anything malformed or unreadable reads as no account, and blocked storage never throws", () => {
  const storage = memoryStorage()
  storage.items.set("elaborating.offline-account.v1", '{"version":1,"userId":"not-a-uuid"}')
  expect(readOfflineAccount(storage)).toBeNull()
  storage.items.set("elaborating.offline-account.v1", "{")
  expect(readOfflineAccount(storage)).toBeNull()
  const blocked = {
    getItem: () => {
      throw new Error("blocked")
    },
    setItem: () => {
      throw new Error("blocked")
    },
    removeItem: () => {
      throw new Error("blocked")
    },
  }
  expect(() => rememberOfflineAccount(account, blocked)).not.toThrow()
  expect(readOfflineAccount(blocked)).toBeNull()
  expect(() => forgetOfflineAccount(blocked)).not.toThrow()
})
