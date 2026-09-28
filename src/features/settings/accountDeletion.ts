/**
 * The server side of Settings > Delete account: what deleting would do
 * (`account_deletion_summary`, read as the person), and the deletion itself
 * (the `delete-account` Edge Function). See "Accounts" in docs/architecture.md.
 */
import { FunctionsHttpError } from "@supabase/supabase-js"
import { z } from "zod"
import { signOutAfter } from "@/features/auth/useAuth"
import { classify } from "@/features/project-storage/remote"
import { forgetAccountOnDevice } from "@/features/projects/account"
import { createClient } from "@/lib/supabase/client"
import { deleteAccount, type DeletionOutcome } from "./deletionFlow"

export const DeletionSummary = z.object({
  /** The projects the person owns, deleted for everyone; `members` is how many people have accepted each. */
  owned: z.array(z.object({ id: z.uuid(), title: z.string(), archived: z.boolean(), members: z.number().int().nonnegative() })),
  /** How many projects shared with them they have accepted, which they leave. */
  shared: z.number().int().nonnegative(),
})
export type DeletionSummary = z.infer<typeof DeletionSummary>

/** What deleting would do; rejects with a sentence to show. */
export async function loadDeletionSummary(): Promise<DeletionSummary> {
  const offline = "Checking your projects needs a connection."
  let response
  try {
    response = await createClient().rpc("account_deletion_summary")
  } catch {
    throw new Error(offline)
  }
  // A request that never reached the server comes back as an error without a code, not as a throw.
  if (response.error) throw new Error(classify(response.error).kind === "network" ? offline : `Could not check your projects: ${response.error.message}`)
  const summary = DeletionSummary.safeParse(response.data)
  if (!summary.success) throw new Error("Could not check your projects. Try again.")
  return summary.data
}

async function deleteOnServer(email: string): Promise<void> {
  const { data, error } = await createClient().functions.invoke("delete-account", { body: { email } })
  if (error instanceof FunctionsHttpError) {
    const body: unknown = await (error.context as Response).json().catch(() => null)
    const parsed = z.object({ error: z.string() }).safeParse(body)
    throw new Error(parsed.success ? parsed.data.error : "Your account could not be deleted. Try again.")
  }
  if (error) throw new Error("Deleting your account needs a connection. Nothing was changed.")
  z.object({ deleted: z.literal(true) }).parse(data)
}

/**
 * Delete the signed-in account, with the email the person typed to confirm
 * it (the server checks it against the account's), then clear this
 * device's copies of its projects and drafts and sign out. With
 * `ignoreGuards`, goes ahead even when a sign-out guard would keep unsaved work.
 */
export function deleteSignedInAccount(userId: string, email: string, ignoreGuards: boolean): Promise<DeletionOutcome> {
  return deleteAccount(
    {
      signOutAfter,
      deleteOnServer: () => deleteOnServer(email),
      forgetOnDevice: () => forgetAccountOnDevice(userId),
    },
    { ignoreGuards },
  )
}
