import { useSyncExternalStore } from "react"
import { readOfflineAccount, useAuth } from "@/features/auth"
import { parseConfig } from "@/lib/config"
import { createClient } from "@/lib/supabase/client"
import { IndexedProjectDatabase } from "@/features/project-storage/database"
import { ProjectFileStore } from "@/features/project-storage/fileStore"
import { ProjectLibrary, offlineRemote, type LibraryState } from "@/features/project-storage/library"
import { partitionKey } from "@/features/project-storage/model"
import { SupabaseProjectRemote } from "@/features/project-storage/remote"

/** Whose projects to show: the signed-in person, or, when the server cannot be reached, the account last signed in here. */
export type ProjectAccount = { userId: string; email: string | null; online: boolean }

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
  const { supabaseUrl } = parseConfig(import.meta.env)
  const partition = partitionKey(supabaseUrl, account.userId)
  const key = `${partition}\n${account.online}`
  let library = libraries.get(key)
  if (!library) {
    database ??= new IndexedProjectDatabase()
    library = new ProjectLibrary(database, account.online ? new SupabaseProjectRemote(createClient()) : offlineRemote, partition)
    libraries.set(key, library)
  }
  return library
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
