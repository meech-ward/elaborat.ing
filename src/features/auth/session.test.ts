import { expect, test } from "bun:test"
import { AuthController, type AuthClientLike } from "./session"

const user = { id: "0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01", email: "person@example.com" } as never
const session = { access_token: "token" } as never

type Reply<T> = { data: T; error?: { status?: number } | null }

/** A fake Auth client whose reads wait until the test releases them. */
function fakeClient(initial: { session: unknown; user: unknown }) {
  let current = initial
  const pending: Array<() => void> = []
  const hold = <T>(value: () => T) =>
    new Promise<T>((resolve, reject) => {
      pending.push(() => {
        try {
          resolve(value())
        } catch (error) {
          reject(error)
        }
      })
    })
  let onChange: (() => void) | null = null
  let failing = false
  const client: AuthClientLike = {
    auth: {
      // Each answer is what the server had when it was asked.
      getSession: () => {
        const answer = current.session
        return hold<Reply<{ session: never }>>(() => {
          if (failing) throw new Error("offline")
          return { data: { session: answer as never } }
        })
      },
      getUser: () => {
        const answer = current.user
        return hold<Reply<{ user: never }>>(() => {
          if (failing) throw new Error("offline")
          return { data: { user: answer as never } }
        })
      },
      onAuthStateChange: (callback) => {
        onChange = callback
        return { data: { subscription: { unsubscribe: () => (onChange = null) } } }
      },
      signOut: async () => {
        current = { session: null, user: null }
        return { error: null }
      },
    },
  }
  return {
    client,
    /** Answer the oldest read waiting, and let the code it resumes run. */
    async releaseOne() {
      pending.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** Answer every read waiting, oldest first (or newest first), including reads they lead to. */
    async release(order: "oldest" | "newest" = "oldest") {
      while (pending.length) {
        ;(order === "oldest" ? pending.shift()! : pending.pop()!)()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    set(next: { session: unknown; user: unknown }) {
      current = next
    },
    fail(value: boolean) {
      failing = value
    },
    emit: () => onChange?.(),
  }
}

test("a session confirmed with the Auth server is signed in", async () => {
  const fake = fakeClient({ session, user })
  const auth = new AuthController(fake.client)
  auth.start()
  expect(auth.getState().status).toBe("loading")
  await fake.release()
  expect(auth.getState()).toMatchObject({ status: "ready", email: "person@example.com" })
})

test("no session is signed out", async () => {
  const fake = fakeClient({ session: null, user: null })
  const auth = new AuthController(fake.client)
  auth.start()
  await fake.release()
  expect(auth.getState().status).toBe("signed-out")
})

test("an older load that answers late never replaces a newer one", async () => {
  const fake = fakeClient({ session, user })
  const auth = new AuthController(fake.client)
  const first = auth.refresh()
  await fake.releaseOne() // the older load has its session and asks for the user while still signed in
  fake.set({ session: null, user: null })
  const second = auth.refresh() // asked after signing out elsewhere
  // The newer load answers first; the older load's user arrives after it.
  await fake.release("newest")
  await Promise.all([first, second])
  expect(auth.getState().status).toBe("signed-out")
})

test("signing out discards a load still in flight", async () => {
  const fake = fakeClient({ session, user })
  const auth = new AuthController(fake.client)
  const loading = auth.refresh()
  await auth.signOut()
  await fake.release()
  await loading
  expect(auth.getState().status).toBe("signed-out")
})

test("someone signed in stays signed in while the Auth server cannot be reached", async () => {
  const fake = fakeClient({ session, user })
  const auth = new AuthController(fake.client)
  auth.start()
  await fake.release()
  fake.fail(true)
  fake.emit()
  await fake.release()
  expect(auth.getState()).toMatchObject({ status: "ready", connectivityError: expect.stringContaining("Could not reach") })
})

test("a first load that cannot reach the Auth server is an error that can be retried", async () => {
  const fake = fakeClient({ session, user })
  fake.fail(true)
  const auth = new AuthController(fake.client)
  auth.start()
  await fake.release()
  expect(auth.getState().status).toBe("error")
  fake.fail(false)
  const retry = auth.refresh()
  await fake.release()
  await retry
  expect(auth.getState().status).toBe("ready")
})
