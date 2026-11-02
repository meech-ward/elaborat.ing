import { describe, expect, test } from "bun:test"
import { RemoteError } from "@/features/project-storage/remote"
import { MAX_CATEGORY_CACHE_LENGTH, ProjectCategoryCache, type CategoryStorage } from "./cache"
import { categoryName, type ProjectCategory } from "./model"
import { SupabaseProjectCategoryRemote, type ProjectCategoryRemote } from "./remote"
import { ProjectCategoryStore } from "./store"

const A = "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01", B = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
const ID = "afba0653-7a9e-45fa-9e1f-1923a7e00813", PROJECT = "d0176f25-23d3-47c1-a3d8-60c868a65ce0"
const partition = (user = A, host = "one.supabase.co") => JSON.stringify([`https://${host}`, user])
const category = (overrides: Partial<ProjectCategory> = {}): ProjectCategory => ({ id: ID, name: "Video scripts", archived_at: null, updated_at: "2026-11-02T12:00:00+00:00", revision: 1, project_ids: [PROJECT], ...overrides })

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function remote(initial = [category()]): ProjectCategoryRemote & { rows: ProjectCategory[] } {
  const fake = {
    rows: initial,
    list: async () => structuredClone(fake.rows),
    create: async (id: string, name: string) => {
      let row = fake.rows.find(value => value.id === id)
      if (!row) { row = category({ id, name, project_ids: [] }); fake.rows.push(row) }
      return structuredClone(row)
    },
    rename: async (id: string, name: string) => { const row = fake.rows.find(value => value.id === id)!; row.name = name; row.revision++; return structuredClone(row) },
    setArchived: async (id: string, archived: boolean) => { const row = fake.rows.find(value => value.id === id)!; row.archived_at = archived ? "2026-11-02T13:00:00Z" : null; row.revision++; return structuredClone(row) },
    setMembership: async (id: string, projectId: string, included: boolean) => {
      const row = fake.rows.find(value => value.id === id)!
      row.project_ids = [...row.project_ids.filter(value => value !== projectId), ...(included ? [projectId] : [])]; row.revision++
      return structuredClone(row)
    },
    setProjectCategories: async (projectId: string, ids: string[]) => {
      for (const row of fake.rows) if (!row.archived_at) await fake.setMembership(row.id, projectId, ids.includes(row.id))
      return fake.list()
    },
  }
  return fake
}

describe("category cache", () => {
  test("is partitioned by backend and user, and a copied foreign envelope is refused", () => {
    const raw = storage(), cache = new ProjectCategoryCache(raw)
    expect(cache.write(partition(), [category()])).toBe(true)
    expect(cache.read(partition()).categories).toEqual([category()])
    expect(cache.read(partition(B)).found).toBe(false)
    expect(cache.read(partition(A, "two.supabase.co")).found).toBe(false)
    raw.values.set(cache.key(partition(B)), raw.values.get(cache.key(partition()))!)
    expect(cache.read(partition(B)).categories).toEqual([])
    cache.clear(partition())
    expect(cache.read(partition()).found).toBe(false)
  })

  test("rejects corrupt, unsupported, duplicate, unbounded and unknown stored data", () => {
    const raw = storage(), cache = new ProjectCategoryCache(raw), key = cache.key(partition())
    const wrapped = (categories: unknown) => JSON.stringify({ version: 1, partition: partition(), categories })
    for (const value of ["{", "x".repeat(MAX_CATEGORY_CACHE_LENGTH + 1), JSON.stringify({ version: 2, partition: partition(), categories: [] }), wrapped([category(), category()]), wrapped([category({ name: " " })]), wrapped([{ ...category(), extra: "unknown" }]), wrapped([category({ project_ids: [PROJECT, PROJECT] })])]) {
      raw.values.set(key, value)
      expect(cache.read(partition()).found).toBe(false)
    }
  })

  test("blocked reads and quota-limited writes are visible without throwing", () => {
    const blocked: CategoryStorage = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("quota") }, removeItem: () => { throw new Error("blocked") } }
    const cache = new ProjectCategoryCache(blocked)
    expect(cache.read(partition()).available).toBe(false)
    expect(cache.write(partition(), [category()])).toBe(false)
    expect(() => cache.clear(partition())).not.toThrow()
  })
})

describe("category state", () => {
  test("cached groups remain browsable offline and organization writes are refused", async () => {
    const raw = storage(), cache = new ProjectCategoryCache(raw)
    cache.write(partition(), [category()])
    const store = new ProjectCategoryStore(partition(), null, cache)
    expect(store.getState()).toMatchObject({ loaded: true, offline: true, categories: [category()] })
    await expect(store.rename(ID, "Work")).rejects.toThrow("Connect to organize")
    expect(cache.read(partition()).categories[0].name).toBe("Video scripts")
  })

  test("server changes update separate metadata without losing a successful write when caching fails", async () => {
    const raw = storage(), server = remote(), cache = new ProjectCategoryCache(raw)
    const store = new ProjectCategoryStore(partition(), server, cache)
    await store.refresh()
    raw.setItem = () => { throw new Error("quota") }
    await store.rename(ID, "Work")
    expect(server.rows[0].name).toBe("Work")
    expect(store.getState()).toMatchObject({ cacheUnavailable: true, offline: false, error: null })
    expect(store.getState().categories[0].name).toBe("Work")
  })

  test("refresh and mutations serialize so an older read cannot restore a previous name", async () => {
    const server = remote(), held = deferred<ProjectCategory[]>(), reads: string[] = []
    server.list = () => { reads.push("read"); return held.promise }
    const rename = server.rename
    server.rename = (id, name) => { reads.push("rename"); return rename(id, name) }
    const store = new ProjectCategoryStore(partition(), server, new ProjectCategoryCache(storage()))
    const refreshing = store.refresh(), duplicate = store.refresh(), renamed = store.rename(ID, "Work")
    expect(duplicate).toBe(refreshing)
    await Promise.resolve()
    expect(reads).toEqual(["read"])
    held.resolve([category()])
    await Promise.all([refreshing, renamed])
    expect(reads).toEqual(["read", "rename"])
    expect(store.getState().categories[0].name).toBe("Work")
    expect(store.getState().busy).toBe(false)
  })

  test("a failed refresh retains cached data and a recovery replaces access-filtered ids", async () => {
    const raw = storage(), cache = new ProjectCategoryCache(raw), server = remote()
    cache.write(partition(), [category()])
    server.list = async () => { throw new RemoteError("network", "offline") }
    const store = new ProjectCategoryStore(partition(), server, cache)
    await store.refresh()
    expect(store.getState()).toMatchObject({ offline: true, error: null, categories: [category()] })
    server.list = async () => [category({ project_ids: [] })]
    await store.refresh()
    expect(store.getState()).toMatchObject({ offline: false })
    expect(cache.read(partition()).categories[0].project_ids).toEqual([])
  })

  test("a cross-tab invalidation during an older read is followed by a fresh server read", async () => {
    const server = remote(), held = deferred<ProjectCategory[]>(), raw = storage(), cache = new ProjectCategoryCache(raw)
    let reads = 0
    server.list = async () => ++reads === 1 ? held.promise : [category({ name: "Updated in another tab", revision: 2 })]
    const store = new ProjectCategoryStore(partition(), server, cache)
    const first = store.refresh()
    await Promise.resolve()
    cache.write(partition(), [category({ name: "Updated in another tab", revision: 2 })])
    store.readCache()
    held.resolve([category()])
    await first
    await store.refresh()
    expect(reads).toBe(2)
    expect(store.getState().categories[0].name).toBe("Updated in another tab")
    expect(cache.read(partition()).categories[0].revision).toBe(2)
  })

  test("retrying a create after a lost answer reuses its original id", async () => {
    const server = remote([]), create = server.create, ids: string[] = []
    let lose = true
    server.create = async (id, name) => { ids.push(id); const row = await create(id, name); if (lose) { lose = false; throw new RemoteError("network", "answer lost") } return row }
    const store = new ProjectCategoryStore(partition(), server, new ProjectCategoryCache(storage()))
    await expect(store.create(" Work ")).rejects.toThrow("answer lost")
    await store.refresh()
    const result = await store.create("Work")
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(server.rows).toHaveLength(1)
    expect(result.id).toBe(ids[0])
  })

  test("project category changes are a single atomic call and retain archived memberships", async () => {
    const archived = category({ id: crypto.randomUUID(), name: "Old", archived_at: "2026-11-01T00:00:00Z" }), server = remote([category(), archived])
    let calls = 0
    const assign = server.setProjectCategories
    server.setProjectCategories = (id, ids) => { calls++; return assign(id, ids) }
    const store = new ProjectCategoryStore(partition(), server, new ProjectCategoryCache(storage()))
    await store.refresh()
    await store.setProjectCategories(PROJECT, [])
    expect(calls).toBe(1)
    expect(store.getState().categories.find(row => row.id === ID)!.project_ids).toEqual([])
    expect(store.getState().categories.find(row => row.id === archived.id)!.project_ids).toEqual([PROJECT])
  })

  test("forgetting an account prevents an in-flight response from restoring its cache", async () => {
    const raw = storage(), cache = new ProjectCategoryCache(raw), server = remote(), held = deferred<ProjectCategory[]>()
    server.list = () => held.promise
    const store = new ProjectCategoryStore(partition(), server, cache)
    const refreshing = store.refresh()
    await Promise.resolve()
    store.forget()
    held.resolve([category()])
    await expect(refreshing).rejects.toThrow("no longer open")
    expect(store.getState().categories).toEqual([])
    expect(raw.values.size).toBe(0)
    expect(store.getState().busy).toBe(false)
  })
})

function rpcClient() {
  const value = { userId: A, token: "test-session-a", requests: [] as Array<{ name: string; args?: Record<string, unknown>; authorization: string }> }
  let gate: Promise<void> = Promise.resolve()
  let headerHook: (() => void) | null = null
  const server = remote([])
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: value.userId }, access_token: value.token } }, error: null }) },
    rpc: (name: string, args?: Record<string, unknown>) => {
      let authorization = ""
      const request = Promise.resolve().then(async () => {
        value.requests.push({ name, args, authorization })
        await gate
        if (name === "create_project_category") return { data: await server.create(args!.category_id as string, args!.name as string), error: null }
        if (name === "rename_project_category") return { data: await server.rename(args!.category_id as string, args!.name as string), error: null }
        return { data: await server.list(), error: null }
      })
      return Object.assign(request, {
        setHeader: (_name: string, content: string) => { authorization = content; headerHook?.(); return request },
      })
    },
  }
  return { value, server, client: client as never, hold: (pending: Promise<void>) => { gate = pending }, onHeader: (callback: () => void) => { headerHook = callback } }
}

describe("category remote account boundary", () => {
  test("a captured RPC keeps its account token if the shared client changes before sending", async () => {
    const fake = rpcClient(), api = new SupabaseProjectCategoryRemote(fake.client, A)
    fake.onHeader(() => { fake.value.userId = B; fake.value.token = "test-session-b" })
    const row = await api.create(ID, "Work")
    expect(row.id).toBe(ID)
    expect(fake.value.requests[0].authorization).toBe("Bearer test-session-a")
    await expect(api.list()).rejects.toThrow("signed-in account changed")
    expect(fake.value.requests).toHaveLength(1)
  })

  test("queued old-account mutations cannot run under a newly signed-in account or cache its data", async () => {
    const fake = rpcClient(), held = deferred<void>(), raw = storage(), cache = new ProjectCategoryCache(raw)
    fake.hold(held.promise)
    const store = new ProjectCategoryStore(partition(), new SupabaseProjectCategoryRemote(fake.client, A), cache)
    const first = store.create("Work"), second = store.rename(ID, "Must not run as B").then(() => null, error => error as Error)
    for (let i = 0; i < 8 && fake.value.requests.length === 0; i++) await Promise.resolve()
    fake.value.userId = B; fake.value.token = "test-session-b"
    held.resolve()
    await first
    expect((await second)?.message).toContain("signed-in account changed")
    expect(fake.value.requests).toHaveLength(1)
    expect(fake.value.requests[0].authorization).toBe("Bearer test-session-a")
    expect(cache.read(partition()).categories.map(row => row.name)).toEqual(["Work"])
    expect(cache.read(partition(B)).found).toBe(false)
    expect([...raw.values.values()].join()).not.toContain("test-session")
  })

  test("external responses are validated before they reach the cache", async () => {
    const fake = rpcClient(), api = new SupabaseProjectCategoryRemote(fake.client, A), raw = storage()
    fake.server.rows = [category({ project_ids: ["not-a-project-id"] })]
    const store = new ProjectCategoryStore(partition(), api, new ProjectCategoryCache(raw))
    await expect(store.refresh()).rejects.toThrow("data this app cannot use")
    expect(raw.values.size).toBe(0)
    expect(store.getState().categories).toEqual([])
  })

  test("database-valid Unicode names remain readable and cacheable", async () => {
    const fake = rpcClient(), raw = storage(), cache = new ProjectCategoryCache(raw)
    const store = new ProjectCategoryStore(partition(), new SupabaseProjectCategoryRemote(fake.client, A), cache)
    // PostgreSQL btrim does not remove NBSP; char_length counts emoji once.
    for (const name of ["\u00a0Video scripts", "😀".repeat(100), "\u00a0"]) {
      fake.server.rows = [category({ name })]
      await store.refresh()
      expect(store.getState().categories[0].name).toBe(name)
      expect(cache.read(partition()).categories[0].name).toBe(name)
    }
    fake.server.rows = [category({ name: "😀".repeat(161) })]
    await expect(store.refresh()).rejects.toThrow("data this app cannot use")
  })
})

test("category names are normalized at the external input boundary", () => {
  expect(categoryName("  Cafe\u0301  ")).toBe("Café")
  expect(categoryName("\u00a0Video scripts\u00a0")).toBe("Video scripts")
  expect(categoryName("😀".repeat(100))).toBe("😀".repeat(100))
  expect(() => categoryName(" \n ")).toThrow("between 1 and 160")
  expect(() => categoryName("a".repeat(161))).toThrow("between 1 and 160")
  expect(() => categoryName("Two\nlines")).toThrow("between 1 and 160")
  expect(() => categoryName("😀".repeat(161))).toThrow("between 1 and 160")
})
