import { useEffect, useSyncExternalStore } from "react"
import { partitionKey } from "@/features/project-storage/model"
import type { ProjectAccount } from "@/features/projects/account"
import { parseConfig } from "@/lib/config"
import { loadedClient } from "@/lib/supabase/client"
import { ProjectCategoryCache } from "./cache"
import { SupabaseProjectCategoryRemote } from "./remote"
import { ProjectCategoryStore } from "./store"

const stores = new Map<string, { userId: string; store: ProjectCategoryStore }>()

export function projectCategoriesFor(account: ProjectAccount): ProjectCategoryStore {
  const partition = account.local ? "local" : partitionKey(parseConfig(import.meta.env).supabaseUrl, account.userId)
  const key = `${partition}\n${account.online}`
  let value = stores.get(key)
  if (!value) {
    value = { userId: account.userId, store: new ProjectCategoryStore(partition,
      account.online && !account.local ? new SupabaseProjectCategoryRemote(loadedClient(), account.userId) : null) }
    stores.set(key, value)
  }
  return value.store
}

/** Mounted only with the home/project chooser, including its chat-panel version. */
export function useProjectCategories(account: ProjectAccount) {
  const store = projectCategoriesFor(account)
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => {
    const refresh = () => { void store.refresh().catch(() => {}) }
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === store.cacheKey) store.readCache() }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener("online", refresh)
    window.addEventListener("focus", refresh)
    window.addEventListener("storage", storage)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("online", refresh)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("storage", storage)
    }
  }, [store])
  return { store, state }
}

export function forgetProjectCategories(userId: string): void {
  for (const [key, value] of stores) if (value.userId === userId) { value.store.forget(); stores.delete(key) }
  const partition = partitionKey(parseConfig(import.meta.env).supabaseUrl, userId)
  new ProjectCategoryCache().clear(partition)
}
