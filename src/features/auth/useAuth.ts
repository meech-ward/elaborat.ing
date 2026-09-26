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
export async function signOut(): Promise<void> {
  const current = authController()
  if (!current) return
  await withSignOutGuards(guards, async () => {
    forgetOfflineAccount()
    await current.signOut()
  })
}

/** Load the session again, for a "Try again" after the sign-in service was unreachable. */
export function retryAuth(): void {
  void authController()?.refresh()
}
