import { RemoteError } from "@/features/project-storage/remote"
import { ProjectCategoryCache } from "./cache"
import { categoryName, type ProjectCategory } from "./model"
import type { ProjectCategoryRemote } from "./remote"

export type ProjectCategoryState = {
  categories: ProjectCategory[]
  loaded: boolean
  busy: boolean
  offline: boolean
  error: string | null
  cacheUnavailable: boolean
}

const message = (error: unknown) => error instanceof Error ? error.message : "Your categories could not be updated. Try again."

/** Organization has its own state and never changes project content or file sync. */
export class ProjectCategoryStore {
  private state: ProjectCategoryState
  private queue: Promise<unknown> = Promise.resolve()
  private refreshing: Promise<void> | null = null
  private cacheInvalidated = false
  private readonly listeners = new Set<() => void>()
  private readonly creating = new Map<string, string>()
  private pending = 0
  private generation = 0
  private forgotten = false

  constructor(readonly partition: string, private readonly remote: ProjectCategoryRemote | null, private readonly cache = new ProjectCategoryCache()) {
    const cached = cache.read(partition)
    this.state = { categories: cached.categories, loaded: cached.found || remote === null, busy: false, offline: remote === null, error: null, cacheUnavailable: !cached.available }
  }

  readonly getState = (): ProjectCategoryState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get cacheKey(): string { return this.cache.key(this.partition) }

  private set(next: Partial<ProjectCategoryState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
  clearError(): void { this.set({ error: null }) }

  private current(generation: number): void {
    if (this.forgotten || generation !== this.generation) throw new RemoteError("access", "This account is no longer open. Open your projects again.")
  }

  private enqueue<T>(work: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.generation
    this.pending++
    this.set({ busy: true })
    const result = this.queue.then(async () => {
      this.current(generation)
      return work(generation)
    }).catch((error: unknown) => {
      if (generation === this.generation) this.set({ loaded: true, error: message(error), ...(error instanceof RemoteError && error.kind === "network" ? { offline: true } : {}) })
      throw error
    }).finally(() => {
      if (generation === this.generation) {
        this.pending--
        this.set({ busy: this.pending > 0 })
      }
    })
    this.queue = result.catch(() => {})
    return result
  }

  private replace(categories: ProjectCategory[]): void {
    const ordered = [...categories].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const persisted = this.cache.write(this.partition, ordered)
    this.set({ categories: ordered, loaded: true, offline: false, error: null, cacheUnavailable: !persisted })
  }

  private update(category: ProjectCategory): void {
    const previous = this.state.categories.find(row => row.id === category.id)
    if (previous && previous.revision > category.revision) return
    this.replace([...this.state.categories.filter(row => row.id !== category.id), category])
  }

  /** A tab with no server connection can still observe another tab's cached changes. */
  readCache(): void {
    if (this.forgotten) return
    if (this.remote) {
      // A storage event can arrive while an older server read is in flight.
      // Ask again after that read, rather than coalescing away the change.
      if (this.refreshing) this.cacheInvalidated = true
      else void this.refresh().catch(() => {})
      return
    }
    const cached = this.cache.read(this.partition)
    this.set({ categories: cached.categories, loaded: true, cacheUnavailable: !cached.available })
  }

  refresh(): Promise<void> {
    if (this.forgotten) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    if (!this.remote) { this.readCache(); return Promise.resolve() }
    const refreshing = this.enqueue(async generation => {
      try {
        const categories = await this.remote!.list()
        this.current(generation)
        this.replace(categories)
      } catch (error) {
        if (error instanceof RemoteError && error.kind === "network") {
          this.current(generation)
          this.set({ offline: true, loaded: true, error: null })
          return
        }
        throw error
      }
    })
    this.refreshing = refreshing
    void refreshing.finally(() => {
      if (this.refreshing !== refreshing) return
      this.refreshing = null
      if (this.cacheInvalidated && !this.forgotten) {
        this.cacheInvalidated = false
        void this.refresh().catch(() => {})
      }
    }).catch(() => {})
    return refreshing
  }

  private writable(): ProjectCategoryRemote {
    if (!this.remote || this.state.offline) throw new RemoteError("network", "Connect to organize your projects. Your saved categories are available offline.")
    return this.remote
  }

  create(input: string): Promise<ProjectCategory> {
    return this.enqueue(async generation => {
      const remote = this.writable(), name = categoryName(input)
      const id = this.creating.get(name) ?? crypto.randomUUID()
      this.creating.set(name, id)
      const category = await remote.create(id, name)
      this.current(generation)
      this.creating.delete(name)
      this.update(category)
      return category
    })
  }

  rename(id: string, name: string): Promise<ProjectCategory> {
    return this.enqueue(async generation => {
      const category = await this.writable().rename(id, categoryName(name))
      this.current(generation)
      this.update(category)
      return category
    })
  }
  setArchived(id: string, archived: boolean): Promise<ProjectCategory> {
    return this.enqueue(async generation => {
      const category = await this.writable().setArchived(id, archived)
      this.current(generation)
      this.update(category)
      return category
    })
  }
  setMembership(categoryId: string, projectId: string, included: boolean): Promise<ProjectCategory> {
    return this.enqueue(async generation => {
      const category = await this.writable().setMembership(categoryId, projectId, included)
      this.current(generation)
      this.update(category)
      return category
    })
  }
  setProjectCategories(projectId: string, categoryIds: string[]): Promise<void> {
    return this.enqueue(async generation => {
      const categories = await this.writable().setProjectCategories(projectId, categoryIds)
      this.current(generation)
      this.replace(categories)
    })
  }

  /** Account deletion invalidates any old in-flight reply before clearing its cache. */
  forget(): void {
    this.forgotten = true
    this.generation++
    this.pending = 0
    this.creating.clear()
    this.cacheInvalidated = false
    this.cache.clear(this.partition)
    this.set({ categories: [], loaded: true, busy: false, error: null })
  }
}
