import { useSyncExternalStore } from "react"
import { parseConfig } from "@/lib/config"
import { loadClient, supabaseConfigured } from "@/lib/supabase/client"
import { withSignOutGuards, type BeforeSignOut } from "./beforeSignOut"
import { forgetOfflineAccount, rememberOfflineAccount } from "./offlineAccount"
import { AuthController, type AuthState } from "./session"

// One controller for the page, like the client it wraps. The client loads in
// a chunk of its own (lib/supabase/client.ts), so the page draws first and
// the session reads as loading until the client is there.
let controller: AuthController | null = null
let starting = false
/** Set when the client could not load; `retryAuth` tries again. */
let loadFailed: AuthState | null = null
const listeners = new Set<() => void>()
const guards = new Set<BeforeSignOut>()

const LOADING: AuthState = { status: "loading" }
const UNCONFIGURED = { status: "unconfigured" } as const
export type AccountState = AuthState | typeof UNCONFIGURED

function notify() {
  for (const listener of [...listeners]) listener()
}

/** Load the client and start the controller, once. */
function startAuth(): void {
  if (controller || starting || !supabaseConfigured()) return
  starting = true
  loadFailed = null
  loadClient().then(
    (client) => {
      const { supabaseUrl } = parseConfig(import.meta.env)
      const created = new AuthController(client)
      created.subscribe(() => {
        const state = created.getState()
        if (state.status === "ready") {
          rememberOfflineAccount({ userId: state.user.id, email: state.email, supabaseUrl })
        }
        notify()
      })
      controller = created
      created.start()
      notify()
    },
    () => {
      starting = false
      loadFailed = { status: "error", message: "Could not load sign-in. Check your connection and try again." }
      notify()
    },
  )
}

function currentState(): AccountState {
  if (!supabaseConfigured()) return UNCONFIGURED
  return controller?.getState() ?? loadFailed ?? LOADING
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  startAuth()
  return () => {
    listeners.delete(listener)
  }
}

/** The signed-in state, kept up to date. */
export function useAuth(): AccountState {
  return useSyncExternalStore(subscribe, currentState)
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
  const current = controller
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
  if (controller) void controller.refresh()
  else startAuth()
}
