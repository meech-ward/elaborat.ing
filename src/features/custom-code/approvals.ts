import { z } from "zod"
import type { ComponentEnvironment } from "@/features/document/componentModules"

/**
 * The custom component code a person chose to run in a project shared with
 * them, remembered on this device. Each file's code is a token: a SHA-256 of
 * its path and its imports and exports as written, so a new version of a
 * component file is a new token and asks again, while edits to a note's
 * prose do not. Only the hashes are stored, never the code or the paths.
 */

/** One file whose code the note runs; `own` is the note itself (its exports). */
export type CodeFile = { path: string; token: string; own: boolean }

const PREFIX = "elaborating.run-components.v1:"
/** The most tokens kept for one project; the oldest go first. */
const LIMIT = 500
const HASH = /^[0-9a-f]{64}$/
const Stored = z.array(z.string().regex(HASH)).max(LIMIT)

async function sha256(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The files whose code a note runs, with their tokens. Without Web Crypto (a
 * page served over plain HTTP) the token is the code itself, which is
 * remembered only while the page is open.
 */
export async function codeFiles(code: ComponentEnvironment["code"], notePath: string): Promise<CodeFile[]> {
  return Promise.all(
    code.map(async (entry) => {
      const path = entry.path ?? notePath
      const material = `${path}\0${entry.esm}`
      return { path, token: (await sha256(material)) ?? material, own: entry.path === null }
    }),
  )
}

/** The files not yet chosen to run. */
export function waitingFiles(files: readonly CodeFile[], approved: ReadonlySet<string>): CodeFile[] {
  return files.filter((file) => !approved.has(file.token))
}

// One set per project key while the page is open, so a choice made in one
// tab of the workbench shows in every other one at once.
const cache = new Map<string, ReadonlySet<string>>()
const listeners = new Set<() => void>()
export const NO_APPROVALS: ReadonlySet<string> = new Set()

function stored(key: string): string[] {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return []
    const parsed = Stored.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** The tokens chosen to run in a project (`key`: the person and the project). */
export function approvedCode(key: string): ReadonlySet<string> {
  let approved = cache.get(key)
  if (!approved) {
    approved = new Set(stored(key))
    cache.set(key, approved)
  }
  return approved
}

/** Remember that the person chose to run these tokens' code. */
export function approveCode(key: string, tokens: readonly string[]): void {
  const next = new Set([...approvedCode(key), ...tokens])
  cache.set(key, next)
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify([...next].filter((token) => HASH.test(token)).slice(-LIMIT)))
  } catch {
    // Storage off (a private window): the choice holds until the page closes.
  }
  for (const listener of listeners) listener()
}

/** Hear choices made here or in another tab. */
export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(PREFIX)) return
    cache.clear()
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}
