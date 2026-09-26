import { z } from "zod"

/**
 * Which account's projects this device may open without signing in: the last
 * account signed in here. It only selects data already on this device; it is
 * never a credential. Signing out forgets it.
 */
const KEY = "elaborating.offline-account.v1"
const OfflineAccount = z.object({ version: z.literal(1), userId: z.uuid(), email: z.string().nullable(), supabaseUrl: z.url() })
export type OfflineAccount = z.infer<typeof OfflineAccount>

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">
const defaultStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function rememberOfflineAccount(account: Omit<OfflineAccount, "version">, storage = defaultStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(OfflineAccount.parse({ version: 1, ...account })))
  } catch {
    // Storage may be full or blocked; offline access is a convenience.
  }
}

export function readOfflineAccount(storage = defaultStorage()): OfflineAccount | null {
  try {
    const raw = storage?.getItem(KEY)
    return raw ? OfflineAccount.parse(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function forgetOfflineAccount(storage = defaultStorage()): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // Signing out must go ahead regardless.
  }
}
