import { useSyncExternalStore } from "react"
import { parseConfig } from "@/lib/config"
import { createClient, supabaseConfigured } from "@/lib/supabase/client"
import { withSignOutGuards, type BeforeSignOut } from "./beforeSignOut"
import { forgetOfflineAccount, rememberOfflineAccount } from "./offlineAccount"
import { AuthController, type AuthState } from "./session"

// One controller for the page, like the client it wraps.
let controller: AuthController | null = null
const guards = new Set<BeforeSignOut>()

function authController(): AuthController | null {
  if (!supabaseConfigured()) return null
  if (!controller) {
    const { supabaseUrl } = parseConfig(import.meta.env)
    const created = new AuthController(createClient())
    created.subscribe(() => {
      const state = created.getState()
      if (state.status === "ready") {
        rememberOfflineAccount({ userId: state.user.id, email: state.email, supabaseUrl })
      }
    })
    created.start()
    controller = created
  }
  return controller
}

const UNCONFIGURED = { status: "unconfigured" } as const
export type AccountState = AuthState | typeof UNCONFIGURED

/** The signed-in state, kept up to date. */
export function useAuth(): AccountState {
  return useSyncExternalStore(
    (notify) => authController()?.subscribe(notify) ?? (() => {}),
    () => authController()?.getState() ?? UNCONFIGURED,
  )
}

/**
 * Run `guard` before any sign-out on this page, for example to keep unsaved
 * edits. Returns a function that removes it.
 */
export function registerBeforeSignOut(guard: BeforeSignOut): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

/** Sign out after every guard has run. Rejects, without signing out, when a guard refuses. */
export function signOut(): Promise<void> {
  return signOutAfter(async () => {})
}

/**
 * Run `work`, then sign out, as one step: every guard runs first, as for any
 * sign-out, unless `ignoreGuards` (the person chose to discard what a guard
 * kept them from losing). Rejects, without signing out, when a guard refuses
 * or `work` fails. Deleting an account uses it.
 */
export async function signOutAfter(work: () => Promise<void>, { ignoreGuards = false } = {}): Promise<void> {
  const current = authController()
  if (!current) return
  const finish = async () => {
    await work()
    forgetOfflineAccount()
    await current.signOut()
  }
  await withSignOutGuards(ignoreGuards ? [] : guards, finish)
}

/** Load the session again, for a "Try again" after the sign-in service was unreachable. */
export function retryAuth(): void {
  void authController()?.refresh()
}
