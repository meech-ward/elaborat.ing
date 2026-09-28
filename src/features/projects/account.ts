import { useSyncExternalStore } from "react"
import { readOfflineAccount, useAuth } from "@/features/auth"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"
import { deleteAccountProjects, IndexedProjectDatabase } from "@/features/project-storage/database"
import { ProjectFileStore } from "@/features/project-storage/fileStore"
import { ProjectLibrary, offlineRemote, type LibraryState } from "@/features/project-storage/library"
import { LOCAL_PARTITION, ensureLocalProject, moveLocalProject, type StarterFiles } from "@/features/project-storage/localProject"
import { partitionKey } from "@/features/project-storage/model"
import { SupabaseProjectRemote } from "@/features/project-storage/remote"

/**
 * Whose projects to show: the signed-in person, or, when the server cannot be
 * reached, the account last signed in here. `local` is someone without an
 * account, who has only the local project kept in this browser.
 */
export type ProjectAccount = { userId: string; email: string | null; online: boolean; local?: boolean }

/** Someone without an account, in the local project. */
export const LOCAL_ACCOUNT: ProjectAccount = { userId: LOCAL_PARTITION, email: null, online: false, local: true }

export type AccountResult =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "signed-out" }
  | { kind: "account"; account: ProjectAccount }

export function useProjectAccount(): AccountResult {
  const auth = useAuth()
  if (auth.status === "unconfigured") return { kind: "unconfigured" }
  if (auth.status === "loading") return { kind: "loading" }
  if (auth.status === "ready") return { kind: "account", account: { userId: auth.user.id, email: auth.email, online: true } }
  if (auth.status === "error") {
    const remembered = readOfflineAccount()
    if (remembered && remembered.supabaseUrl === parseConfig(import.meta.env).supabaseUrl) {
      return { kind: "account", account: { userId: remembered.userId, email: remembered.email, online: false } }
    }
  }
  return { kind: "signed-out" }
}

let database: IndexedProjectDatabase | null = null
const libraries = new Map<string, ProjectLibrary>()

/** The account's project library, one per account and connection state for the page. */
export function libraryFor(account: ProjectAccount): ProjectLibrary {
  const partition = account.local ? LOCAL_PARTITION : partitionKey(parseConfig(import.meta.env).supabaseUrl, account.userId)
  const key = `${partition}\n${account.online}`
  let library = libraries.get(key)
  if (!library) {
    database ??= new IndexedProjectDatabase()
    library = new ProjectLibrary(database, account.online ? new SupabaseProjectRemote(createClient()) : offlineRemote, partition)
    libraries.set(key, library)
  }
  return library
}

/**
 * After an account is deleted: remove its projects, files and drafts from
 * this device, and the view settings kept for them (their keys hold the
 * account's id). Other accounts' projects and the local project stay.
 */
export async function forgetAccountOnDevice(userId: string): Promise<void> {
  const partition = partitionKey(parseConfig(import.meta.env).supabaseUrl, userId)
  for (const key of [...libraries.keys()]) if (key.startsWith(`${partition}\n`)) libraries.delete(key)
  database ??= new IndexedProjectDatabase()
  await deleteAccountProjects(database, partition)
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.includes(userId)) localStorage.removeItem(key)
    }
  } catch {
    // Storage may be blocked; view settings hold no content.
  }
}

/** Set once this browser has made a local project with the welcome note, so it is made only once. */
const WELCOMED_KEY = "elaborating.local-welcome.v1"

/**
 * Loads the welcome note's files (./welcomeNote). Each caller passes its own
 * `() => import("./welcomeNote")`, so the pages that never need it (and the
 * code every page shares) do not name its chunk.
 */
export type WelcomeLoader = () => Promise<{ WELCOME_NOTE: string; WELCOME_FILES: StarterFiles }>

/**
 * Make sure the local project is on this device, for someone without an
 * account. The first one this browser makes starts with the welcome note;
 * then this resolves to the note's path, otherwise to null.
 */
export async function openLocalProject(welcome: WelcomeLoader): Promise<string | null> {
  database ??= new IndexedProjectDatabase()
  const made: { note?: string } = {}
  const created = await ensureLocalProject(database, undefined, async () => {
    if (readFlag(WELCOMED_KEY)) return []
    const { WELCOME_NOTE, WELCOME_FILES } = await welcome()
    made.note = WELCOME_NOTE
    return WELCOME_FILES
  })
  if (!created || !made.note) return null
  writeFlag(WELCOMED_KEY)
  return made.note
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1")
  } catch {
    // Storage may be blocked; then each new local project is welcomed.
  }
}

const moves = new Map<string, Promise<string | null>>()

/**
 * After signing in: move the local project, if it has files of the person's
 * own, into the account's library, where sync uploads it. Its id, or null.
 * Once per page.
 */
export function moveLocalProjectTo(library: ProjectLibrary, welcome: WelcomeLoader): Promise<string | null> {
  database ??= new IndexedProjectDatabase()
  const db = database
  let moving = moves.get(library.partition)
  if (!moving) {
    // A local project with only the welcome, as it was made, holds nothing of the person's to keep.
    moving = moveLocalProject(db, library.partition, undefined, async () => (await welcome()).WELCOME_FILES).then(async (id) => {
      if (id) await library.load()
      return id
    })
    moves.set(library.partition, moving)
  }
  return moving
}

/** One project's files on this device, for the account's library. */
export function fileStoreFor(library: ProjectLibrary, projectId: string): ProjectFileStore {
  database ??= new IndexedProjectDatabase()
  return new ProjectFileStore(database, library.partition, projectId)
}

export function useLibraryState(library: ProjectLibrary): LibraryState {
  return useSyncExternalStore(
    (notify) => library.subscribe(notify),
    () => library.getState(),
  )
}
