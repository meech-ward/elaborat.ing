import { describe, expect, test } from "bun:test"
import { OwnerFileSharingRemote, sharedFileHref } from "./ownerRemote"
import { fileSharingProblem, supportsFileSharing } from "./ownerEligibility"
import type { WorkspaceFileRef } from "@/features/workbench/workspaceStore"

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const PROJECT = "33333333-3333-4333-8333-333333333333"
const FILE = "44444444-4444-4444-8444-444444444444"
const row = () => ({ id: "55555555-5555-4555-8555-555555555555", file_id: FILE, path: "notes/plan.mdx", token: "a".repeat(64), created_at: "2026-11-03T10:00:00Z", revoked_at: null })

function fakeClient() {
  const state = { user: USER as string | null, token: "owner-session", result: row() as unknown, error: null as null | { code: string; message: string }, calls: [] as Array<{ name: string; args: unknown; authorization: string }>, onHeader: () => {} }
  const client = {
    auth: { getSession: async () => ({ data: { session: state.user ? { user: { id: state.user }, access_token: state.token } : null }, error: null }) },
    rpc: (name: string, args: unknown) => ({
      setHeader: (_name: string, authorization: string) => {
        state.onHeader()
        state.calls.push({ name, args, authorization })
        return Promise.resolve({ data: state.result, error: state.error })
      },
    }),
  }
  return { state, client: client as never }
}

describe("owner file sharing boundary", () => {
  test("reads existing metadata and maps enable, rotation and revocation to the scoped RPC", async () => {
    const { state, client } = fakeClient(), remote = new OwnerFileSharingRemote(client, USER)
    expect(await remote.get(PROJECT, FILE)).toEqual(row())
    await remote.set(PROJECT, FILE, true)
    await remote.set(PROJECT, FILE, true, true)
    state.result = null
    expect(await remote.set(PROJECT, FILE, false)).toBeNull()
    expect(state.calls.map(call => ({ name: call.name, args: call.args }))).toEqual([
      { name: "get_file_share", args: { project_id: PROJECT, file_id: FILE } },
      { name: "set_file_share", args: { project_id: PROJECT, file_id: FILE, enabled: true, replace_link: false } },
      { name: "set_file_share", args: { project_id: PROJECT, file_id: FILE, enabled: true, replace_link: true } },
      { name: "set_file_share", args: { project_id: PROJECT, file_id: FILE, enabled: false, replace_link: false } },
    ])
  })

  test("fails closed after account change and pins in-flight calls to the checked session", async () => {
    const { state, client } = fakeClient(), remote = new OwnerFileSharingRemote(client, USER)
    state.onHeader = () => { state.user = OTHER; state.token = "another-session" }
    await remote.set(PROJECT, FILE, true)
    expect(state.calls[0].authorization).toBe("Bearer owner-session")
    await expect(remote.set(PROJECT, FILE, false)).rejects.toThrow("signed-in account changed")
    state.user = null
    await expect(remote.get(PROJECT, FILE)).rejects.toThrow("signed-in account changed")
    expect(state.calls).toHaveLength(1)
  })

  test("does not use foreign-file, malformed-token or invalid metadata responses", async () => {
    const { state, client } = fakeClient(), remote = new OwnerFileSharingRemote(client, USER)
    for (const value of [{ ...row(), file_id: OTHER }, { ...row(), token: "x".repeat(64) }, { ...row(), token: "a".repeat(65) }, { ...row(), path: "../secret" }, { ...row(), created_at: "yesterday" }, { ...row(), revoked_at: true }]) {
      state.result = value
      await expect(remote.get(PROJECT, FILE)).rejects.toThrow("data this app cannot use")
    }
    state.result = null
    expect(await remote.get(PROJECT, FILE)).toBeNull()
    state.result = { ...row(), revoked_at: "2026-11-03T11:00:00Z" }
    expect((await remote.get(PROJECT, FILE))?.revoked_at).toBe("2026-11-03T11:00:00Z")
  })

  test("refuses invalid IDs before a request and preserves server access refusals", async () => {
    const { state, client } = fakeClient(), remote = new OwnerFileSharingRemote(client, USER)
    await expect(remote.get("not-a-project", FILE)).rejects.toThrow()
    expect(state.calls).toHaveLength(0)
    state.error = { code: "42501", message: "Only the project owner can share a file" }
    await expect(remote.set(PROJECT, FILE, true)).rejects.toThrow("Only the project owner")
  })

  test("constructs only a validated file-link path on the current site", () => {
    expect(sharedFileHref("https://elaborat.ing/project/path", "a".repeat(64))).toBe(`https://elaborat.ing/s/${"a".repeat(64)}`)
    expect(() => sharedFileHref("https://elaborat.ing", "https://other.example/")).toThrow("Invalid file link")
  })
})

const saved = (changes: Partial<WorkspaceFileRef> = {}): WorkspaceFileRef => ({ path: "notes/plan.mdx", revision: "saved-token", server: { id: FILE, version: 4 }, draft: false, unsynced: false, conflict: false, size: 42, ...changes })

describe("owner sharing eligibility", () => {
  test("supports rendered notes, native drawings, diagrams and image formats", () => {
    for (const path of ["plan.md", "PLAN.MDX", "sketch.excalidraw", "sketch.excalidraw.md", "flow.d2", "one.PNG", "two.jpg", "three.jpeg", "four.webp", "five.gif", "six.svg"]) expect(supportsFileSharing(path)).toBe(true)
    for (const path of ["file.txt", "scene.json", "flow.d2.json", "package.js"]) expect(supportsFileSharing(path)).toBe(false)
  })

  test("refuses missing, unsaved, unsynced, conflicting and still-edited copies", () => {
    expect(fileSharingProblem(undefined)).toContain("rendered sharing")
    expect(fileSharingProblem(saved({ server: null }))).toContain("Save and sync")
    expect(fileSharingProblem(saved({ revision: null }))).toContain("Save and sync")
    expect(fileSharingProblem(saved({ unsynced: true }))).toContain("Sync this file")
    expect(fileSharingProblem(saved({ conflict: true }))).toContain("sync conflict")
    expect(fileSharingProblem(saved({ draft: true }))).toContain("unsaved changes")
    expect(fileSharingProblem(saved(), true)).toContain("unsaved changes")
    expect(fileSharingProblem(saved({ path: "logo.svg" }))).toContain("Import this image")
    expect(fileSharingProblem(saved({ path: "logo.svg", kind: "image" }))).toBeNull()
    expect(fileSharingProblem(saved())).toBeNull()
  })
})
