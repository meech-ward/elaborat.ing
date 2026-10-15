import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js"

/**
 * The signed-in state, as a small state machine with no React in it, so its
 * races are tested directly. The React hook in `useAuth.ts` only subscribes.
 */
export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  /** Signed in and confirmed with the Auth server. `connectivityError` is set while the server cannot be reached. */
  | { status: "ready"; user: User; email: string | null; connectivityError?: string }
  | { status: "error"; message: string }

/** The part of the Supabase client the controller uses; tests pass fakes. */
export interface AuthClientLike {
  auth: {
    getSession(): Promise<{ data: { session: Session | null }; error?: { status?: number } | null }>
    getUser(): Promise<{ data: { user: User | null }; error?: { status?: number } | null }>
    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } }
    signOut(): Promise<{ error: { message: string } | null }>
  }
}

const UNREACHABLE = "Could not reach the sign-in service. Check your connection and try again."

/**
 * Loads the session and confirms the user with the Auth server. A generation
 * counter discards any answer that arrives after a newer load or a sign-out.
 * Someone already signed in stays signed in while the Auth server cannot be
 * reached: their work is on this device, and every request to the server is
 * still checked there.
 */
export class AuthController {
  private generation = 0
  private state: AuthState = { status: "loading" }
  private readonly listeners = new Set<() => void>()
  private subscription: { unsubscribe(): void } | null = null

  constructor(private readonly client: AuthClientLike) {}

  getState(): AuthState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(next: AuthState) {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  private unreachable() {
    this.setState(this.state.status === "ready" ? { ...this.state, connectivityError: UNREACHABLE } : { status: "error", message: UNREACHABLE })
  }

  /** Listen for sign-in and sign-out events and load the current session. Every event loads it again, except a token refresh. */
  start(): void {
    if (!this.subscription) {
      this.subscription = this.client.auth.onAuthStateChange((event, session) => {
        if (event === "TOKEN_REFRESHED") this.tokenRefreshed(session)
        else void this.refresh()
      }).data.subscription
    }
    void this.refresh()
  }

  /**
   * A new token for the same session, so nothing is loaded again: a load reads
   * the session, and supabase-js refreshes a token it reads within 90 s of
   * expiring by the device's clock. Where that clock runs an hour ahead, every
   * new token looks that close, and each load would refresh it and come back
   * here. The refresh reached the Auth server, so someone it could not reach
   * before is signed in again with the session it carries. Anyone else keeps
   * their state: a signed-out page stays signed out, and a load in flight
   * still decides.
   */
  private tokenRefreshed(session: Session | null): void {
    const unreachable = this.state.status === "error" || (this.state.status === "ready" && this.state.connectivityError !== undefined)
    if (unreachable && session?.user) this.setState({ status: "ready", user: session.user, email: session.user.email ?? null })
  }

  stop(): void {
    this.subscription?.unsubscribe()
    this.subscription = null
  }

  async refresh(): Promise<void> {
    await this.load(++this.generation)
  }

  private async load(generation: number): Promise<void> {
    let session: Session | null
    try {
      const result = await this.client.auth.getSession()
      if (result.error && (!result.error.status || result.error.status >= 500)) throw new Error("Session unavailable")
      session = result.data.session
    } catch {
      if (generation === this.generation) this.unreachable()
      return
    }
    if (generation !== this.generation) return
    if (!session) {
      this.setState({ status: "signed-out" })
      return
    }
    let user: User | null
    try {
      const result = await this.client.auth.getUser()
      if (result.error && (!result.error.status || result.error.status >= 500)) throw new Error("Auth unavailable")
      user = result.data.user
    } catch {
      if (generation === this.generation) this.unreachable()
      return
    }
    if (generation !== this.generation) return
    this.setState(user ? { status: "ready", user, email: user.email ?? null } : { status: "signed-out" })
  }

  /** Sign out and discard any load still in flight. Never throws; the page signs out even if the server call fails. */
  async signOut(): Promise<void> {
    this.generation += 1
    try {
      await this.client.auth.signOut()
    } catch {
      // The local session is cleared either way.
    }
    this.setState({ status: "signed-out" })
  }
}
