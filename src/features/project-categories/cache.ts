import { z } from "zod/mini"
import { CachedProjectCategories, type ProjectCategory } from "./model"

export type CategoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
export const MAX_CATEGORY_CACHE_LENGTH = 2 * 1024 * 1024
const Record = z.strictObject({ version: z.literal(1), partition: z.string(), categories: CachedProjectCategories })

function browserStorage(): CategoryStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage } catch { return null }
}

/** A separate account sidecar; old project IndexedDB rows remain unchanged. */
export class ProjectCategoryCache {
  constructor(private readonly storage: CategoryStorage | null = browserStorage()) {}

  key(partition: string): string { return `elaborating:project-categories:v1:${partition}` }

  read(partition: string): { categories: ProjectCategory[]; available: boolean; found: boolean } {
    let raw: string | null | undefined
    try { raw = this.storage?.getItem(this.key(partition)) }
    catch { return { categories: [], available: false, found: false } }
    try {
      if (!raw || raw.length > MAX_CATEGORY_CACHE_LENGTH) return { categories: [], available: this.storage !== null, found: false }
      const parsed = Record.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.partition !== partition || new Set(parsed.data.categories.map(category => category.id)).size !== parsed.data.categories.length)
        return { categories: [], available: true, found: false }
      return { categories: parsed.data.categories, available: true, found: true }
    } catch { return { categories: [], available: true, found: false } }
  }

  write(partition: string, categories: ProjectCategory[]): boolean {
    try {
      if (!this.storage) return false
      const raw = JSON.stringify(Record.parse({ version: 1, partition, categories }))
      if (raw.length > MAX_CATEGORY_CACHE_LENGTH) return false
      this.storage.setItem(this.key(partition), raw)
      return true
    } catch { return false }
  }

  clear(partition: string): void {
    try { this.storage?.removeItem(this.key(partition)) } catch { /* Account cleanup must finish even if browser storage is blocked. */ }
  }
}
