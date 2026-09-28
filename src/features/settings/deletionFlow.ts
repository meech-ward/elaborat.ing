/**
 * Deleting an account from this device, as one step with signing out: the
 * sign-out guards run first (keeping unsaved edits, or refusing with the
 * reason), then the server deletes the account, then this device forgets
 * the account's projects and drafts, then the page signs out. No React here,
 * so each outcome is tested directly.
 */

export type DeletionOutcome =
  | { kind: "deleted" }
  /** A sign-out guard refused; nothing was deleted. The person may delete anyway. */
  | { kind: "kept"; reason: string }
  /** The server refused or failed; the person is still signed in. */
  | { kind: "failed"; message: string }

export type DeletionSteps = {
  /** Runs `work` and then signs out, after the sign-out guards unless `ignoreGuards`. */
  signOutAfter: (work: () => Promise<void>, options: { ignoreGuards: boolean }) => Promise<void>
  /** Asks the server to delete the account; rejects with a message to show. */
  deleteOnServer: () => Promise<void>
  /** Removes the account's projects and drafts from this device. */
  forgetOnDevice: () => Promise<void>
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export async function deleteAccount(steps: DeletionSteps, { ignoreGuards }: { ignoreGuards: boolean }): Promise<DeletionOutcome> {
  let reachedServer = false
  try {
    await steps.signOutAfter(
      async () => {
        reachedServer = true
        await steps.deleteOnServer()
        // The account is gone either way; signing out matters more than a copy left behind.
        await steps.forgetOnDevice().catch(() => {})
      },
      { ignoreGuards },
    )
    return { kind: "deleted" }
  } catch (cause) {
    return reachedServer ? { kind: "failed", message: message(cause) } : { kind: "kept", reason: message(cause) }
  }
}
