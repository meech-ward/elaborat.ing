import { describe, expect, test } from "bun:test"
import { withSignOutGuards, type BeforeSignOut } from "@/features/auth/beforeSignOut"
import { deleteAccount, type DeletionSteps } from "./deletionFlow"

/** The steps, with the real guard runner over `guards`, recording what ran in order. */
function steps(guards: BeforeSignOut[], { serverError = null as string | null, deviceError = false } = {}) {
  const log: string[] = []
  const run: DeletionSteps = {
    signOutAfter: (work, { ignoreGuards }) =>
      withSignOutGuards(ignoreGuards ? [] : guards, async () => {
        await work()
        log.push("signed out")
      }),
    deleteOnServer: async () => {
      log.push("server")
      if (serverError) throw new Error(serverError)
    },
    forgetOnDevice: async () => {
      log.push("device")
      if (deviceError) throw new Error("IndexedDB is unavailable")
    },
  }
  return { run, log }
}

const keeps = (log: string[]): BeforeSignOut => async () => {
  log.push("draft kept")
  return () => log.push("released")
}
const refuses: BeforeSignOut = async () => {
  throw new Error("note.md is not reconciled. Save or reload it before leaving.")
}

describe("deleting an account", () => {
  test("guards run first, then the server, then the device, then sign-out, and the guard is released last", async () => {
    const shared: string[] = []
    const { run, log } = steps([keeps(shared)])
    expect(await deleteAccount(run, { ignoreGuards: false })).toEqual({ kind: "deleted" })
    expect([...shared.slice(0, 1), ...log, ...shared.slice(1)]).toEqual(["draft kept", "server", "device", "signed out", "released"])
  })

  test("a guard that refuses stops everything, with its reason", async () => {
    const { run, log } = steps([refuses])
    expect(await deleteAccount(run, { ignoreGuards: false })).toEqual({
      kind: "kept",
      reason: "note.md is not reconciled. Save or reload it before leaving.",
    })
    expect(log).toEqual([])
  })

  test("delete anyway skips the guards", async () => {
    const { run, log } = steps([refuses])
    expect(await deleteAccount(run, { ignoreGuards: true })).toEqual({ kind: "deleted" })
    expect(log).toEqual(["server", "device", "signed out"])
  })

  test("a server refusal keeps the person signed in and their device copies, with the server's message", async () => {
    const shared: string[] = []
    const { run, log } = steps([keeps(shared)], { serverError: "You have reached the limit of 5 account deletion attempts a day. Try again in 5 hours." })
    expect(await deleteAccount(run, { ignoreGuards: false })).toEqual({
      kind: "failed",
      message: "You have reached the limit of 5 account deletion attempts a day. Try again in 5 hours.",
    })
    expect(log).toEqual(["server"])
    expect(shared).toEqual(["draft kept", "released"])
  })

  test("once the account is deleted, sign-out goes ahead even if this device's copies could not be removed", async () => {
    const { run, log } = steps([], { deviceError: true })
    expect(await deleteAccount(run, { ignoreGuards: false })).toEqual({ kind: "deleted" })
    expect(log).toEqual(["server", "device", "signed out"])
  })
})
