import type { Session, User } from "@supabase/supabase-js"

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
    onAuthStateChange(callback: () => void): { data: { subscription: { unsubscribe(): void } } }
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

  /** Listen for sign-in and sign-out events and load the current session. */
  start(): void {
    if (!this.subscription) {
      this.subscription = this.client.auth.onAuthStateChange(() => {
        void this.refresh()
      }).data.subscription
    }
    void this.refresh()
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
