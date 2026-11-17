import { describe, expect, test } from "bun:test"
import { createClient } from "@supabase/supabase-js"
import { MAX_FILE_BYTES } from "../project-storage/model"
import { RemoteError } from "../project-storage/remote"
import { FileVersion, SupabaseFileHistoryRemote, type FileVersionContent } from "./remote"

const PROJECT = "10000000-0000-4000-8000-000000000001"
const FILE = "20000000-0000-4000-8000-000000000001"
const AUTHOR = "30000000-0000-4000-8000-000000000001"
const row = (version: number, created_at = "2026-11-12T10:00:00Z", extra: Partial<FileVersionContent> = {}): FileVersionContent => ({
  file_id: FILE, version, created_at, path: "note.md", kind: "text", asset: null, deleted: false, author_id: AUTHOR, content: `Save ${version}`, ...extra,
})

function server(rows: FileVersionContent[], respond?: (url: URL) => Response | undefined) {
  const requests: URL[] = []
  const client = createClient("https://history.example.test", "public", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      requests.push(url)
      const override = respond?.(url)
      if (override) return override
      let found = [...rows]
      const exact = url.searchParams.get("version")
      if (exact?.startsWith("eq.")) found = found.filter(row => row.version === Number(exact.slice(3)))
      if (exact?.startsWith("lt.")) found = found.filter(row => row.version < Number(exact.slice(3)))
      const before = url.searchParams.get("created_at")
      if (before?.startsWith("lt.")) found = found.filter(row => Date.parse(row.created_at) < Date.parse(before.slice(3)))
      const keyset = url.searchParams.get("or")
      if (keyset) {
        const parts = /^\(created_at\.lt\.(.+),and\(created_at\.eq\..+,version\.lt\.(\d+)\)\)$/.exec(keyset)
        if (!parts) throw new Error(`Unexpected cursor ${keyset}`)
        const time = Date.parse(parts[1])
        found = found.filter(row => Date.parse(row.created_at) < time || (Date.parse(row.created_at) === time && row.version < Number(parts[2])))
      }
      const chronological = url.searchParams.get("order")?.startsWith("created_at")
      found.sort((a, b) => chronological ? Date.parse(b.created_at) - Date.parse(a.created_at) || b.version - a.version : b.version - a.version)
      found = found.slice(0, Number(url.searchParams.get("limit") ?? found.length))
      const columns = url.searchParams.get("select")?.split(",") ?? []
      const selected = found.map(row => Object.fromEntries(columns.map(column => [column, row[column as keyof FileVersionContent]])))
      return Response.json(new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object") ? selected[0] ?? null : selected)
    }) as typeof fetch },
  })
  return { remote: new SupabaseFileHistoryRemote(client), requests }
}

describe("existing immutable file version reads", () => {
  test("loads only one file's metadata with explicit granted columns and returns the day predecessor", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => row(index + 1, index >= 70 ? "2026-11-12T10:00:00Z" : "2026-11-11T10:00:00Z"))
    const { remote, requests } = server(rows)
    const page = await remote.list(PROJECT, FILE)
    expect(page.versions.map(row => row.version)).toEqual(Array.from({ length: 50 }, (_, index) => 120 - index))
    expect(page.more).toBe(true)
    expect(page.previous?.version).toBe(70)
    expect(requests).toHaveLength(1)
    expect(requests[0].searchParams.get("project_id")).toBe(`eq.${PROJECT}`)
    expect(requests[0].searchParams.get("file_id")).toBe(`eq.${FILE}`)
    expect(requests[0].searchParams.get("limit")).toBe("100")
    expect(requests[0].searchParams.get("select")?.split(",")).not.toContain("content")
    expect(requests[0].searchParams.get("select")?.split(",")).not.toContain("agent_client_id")
  })

  test("preserves every save across busy days, equal timestamps, moves, deletions, and multiple pages", async () => {
    const rows = [row(1, "2026-11-10T10:00:00Z"), ...Array.from({ length: 70 }, (_, i) => row(i + 2, "2026-11-11T10:00:00Z")), ...Array.from({ length: 250 }, (_, i) => row(i + 72, "2026-11-12T10:00:00Z", i === 249 ? { content: null, deleted: true, path: "renamed.md" } : {}))]
    const { remote, requests } = server(rows)
    const first = await remote.list(PROJECT, FILE)
    expect(first.versions).toHaveLength(250)
    expect(first.more).toBe(true)
    expect(first.previous?.version).toBe(71)
    expect(requests).toHaveLength(3)
    const second = await remote.list(PROJECT, FILE, "2026-11-12")
    expect(second.more).toBe(false)
    expect([...first.versions, ...second.versions].map(row => row.version).sort((a, b) => a - b)).toEqual(rows.map(row => row.version))
    expect(first.versions[0].deleted).toBe(true)
    expect(first.versions[0].path).toBe("renamed.md")
    expect(requests[3].searchParams.get("created_at")).toBe("lt.2026-11-12T00:00:00Z")
  })

  test("paginates by actual UTC day when revision and transaction timestamps cross midnight out of order", async () => {
    const newerDay = Array.from({ length: 101 }, (_, i) => row(2 * i + 1, "2026-11-13T00:00:01Z"))
    const olderDay = Array.from({ length: 101 }, (_, i) => row(2 * i + 2, "2026-11-12T23:59:59Z"))
    const { remote } = server([...newerDay, ...olderDay])
    const first = await remote.list(PROJECT, FILE)
    const second = await remote.list(PROJECT, FILE, "2026-11-13")
    expect(first.versions.map(row => row.version)).toEqual(newerDay.map(row => row.version).reverse())
    expect(second.versions.map(row => row.version)).toEqual(olderDay.map(row => row.version).reverse())
    expect(second.more).toBe(false)
    expect((await remote.predecessor(PROJECT, FILE, 201))?.version).toBe(200)
    expect(await remote.predecessor(PROJECT, FILE, 1)).toBeNull()
  })

  test("retains Postgres microsecond precision in internal cursors", async () => {
    let calls = 0
    const first = Array.from({ length: 100 }, (_, i) => row(200 - i, "2026-11-12T10:00:00.123456+00:00"))
    const next = row(201, "2026-11-12T10:00:00.123455+00:00")
    const { remote, requests } = server([], () => Response.json(calls++ === 0 ? first : [next]))
    const result = await remote.list(PROJECT, FILE)
    expect(result.versions).toHaveLength(101)
    expect(result.versions.at(-1)?.version).toBe(201)
    expect(requests[1].searchParams.get("or")).toContain("created_at.lt.2026-11-12T10:00:00.123456+00:00")
  })

  test("reads exact content on demand and preserves empty text versus deletion", async () => {
    const { remote, requests } = server([row(1, undefined, { content: "" }), row(2, undefined, { deleted: true, content: null })])
    expect((await remote.content(PROJECT, FILE, 1)).content).toBe("")
    expect((await remote.content(PROJECT, FILE, 2)).content).toBeNull()
    expect(requests[0].searchParams.get("version")).toBe("eq.1")
    expect(requests[0].searchParams.get("select")).toContain(",content")
  })

  test("validates malformed rows, timezone-less timestamps, oversized contents, and mismatched file identities", async () => {
    expect(FileVersion.safeParse(row(1, "2026-11-12T10:00:00")).success).toBe(false)
    const badVersion = server([], () => Response.json([{ ...row(1), version: -1 }]))
    await expect(badVersion.remote.list(PROJECT, FILE)).rejects.toThrow()
    const badFile = server([row(1, undefined, { file_id: AUTHOR })])
    await expect(badFile.remote.list(PROJECT, FILE)).rejects.toThrow("does not belong")
    const wrongDeletion = server([row(1, undefined, { content: null, deleted: false })])
    await expect(wrongDeletion.remote.content(PROJECT, FILE, 1)).rejects.toThrow()
    const tooLarge = server([row(1, undefined, { content: "é".repeat(MAX_FILE_BYTES / 2 + 1) })])
    await expect(tooLarge.remote.content(PROJECT, FILE, 1)).rejects.toThrow("larger than 2 MiB")
  })

  test("rejects malformed day cursors and nonadvancing result pages", async () => {
    const { remote, requests } = server([])
    await expect(remote.list(PROJECT, FILE, "2026-02-30")).rejects.toThrow()
    await expect(remote.list(PROJECT, FILE, "version.lt.5")).rejects.toThrow()
    expect(requests).toHaveLength(0)
    const repeating = server([], () => Response.json([row(1), row(1)]))
    await expect(repeating.remote.list(PROJECT, FILE)).rejects.toThrow("out of order")
    const oversized = server([], () => Response.json(Array.from({ length: 101 }, (_, i) => row(101 - i))))
    await expect(oversized.remote.list(PROJECT, FILE)).rejects.toThrow()
  })

  test("keeps author names validated and classifies access and network refusals", async () => {
    const { remote } = server([], url => url.pathname.endsWith("list_members") ? Response.json([{ user_id: AUTHOR, name: "Ada", email: "ada@example.test", role: "owner", accepted_at: null, invited_at: null }]) : undefined)
    expect(await remote.authors(PROJECT)).toEqual([{ user_id: AUTHOR, name: "Ada", email: "ada@example.test" }])
    const denied = server([], () => Response.json({ code: "42501", message: "Project unavailable" }, { status: 403 }))
    try { await denied.remote.list(PROJECT, FILE); throw new Error("Expected refusal") }
    catch (error) { expect(error).toBeInstanceOf(RemoteError); expect((error as RemoteError).kind).toBe("access") }
    const malformed = server([], () => Response.json([{ user_id: "bad" }]))
    await expect(malformed.remote.authors(PROJECT)).rejects.toThrow()
    const disconnected = new SupabaseFileHistoryRemote({ rpc: () => Promise.reject(new TypeError("Failed to fetch")) } as unknown as ConstructorParameters<typeof SupabaseFileHistoryRemote>[0])
    try { await disconnected.authors(PROJECT); throw new Error("Expected refusal") }
    catch (error) { expect(error).toBeInstanceOf(RemoteError); expect((error as RemoteError).kind).toBe("network") }
  })
})
