import { z } from 'npm:zod@4.4.3'

// Delete the caller's own account, for a signed-in person who has typed their
// email to confirm. Only people delete accounts: a token issued to an OAuth
// client (an agent) is refused, and so is it in the database.
//
// Everything that can run as the caller does: `begin_account_deletion`
// refuses agents, counts the daily limit and lists the projects the caller
// owns, and `delete_project` deletes each one for everyone, as it would from
// the project page. Only then does the service role delete the account
// itself, through Auth's admin API, which ends its sessions and agent
// connections, removes its memberships and leaves its comments with no
// author. A failure part way leaves the account in place, so trying again
// carries on where it stopped.

export const DeleteRequest = z.object({ email: z.string().max(320) })

/** Who is calling, from their verified access token. */
export type Caller = {
  id: string
  /** Set when the token was issued to an OAuth client, such as an agent. */
  clientId: string | null
}

type DbError = { code?: string; message: string }
type Answer<T> = { data: T | null; error: DbError | null }

/** What `begin_account_deletion` answers: the projects the caller owns. */
export const Summary = z.object({
  owned: z.array(z.object({ id: z.uuid(), title: z.string() })),
})

export type DeleteAccountDeps = {
  /** The account's email, with the service role; data null when the account no longer exists. */
  readAccount: (userId: string) => Promise<{ data: { email: string | null } | null; error: { message: string } | null }>
  /** public.begin_account_deletion, as the caller. */
  begin: () => Promise<Answer<unknown>>
  /** public.delete_project, as the caller. */
  deleteProject: (projectId: string) => Promise<Answer<unknown>>
  /** Auth's admin delete, with the service role. */
  deleteUser: (userId: string) => Promise<{ error: { message: string; status?: number } | null }>
}

const refuse = (status: number, error: string) => Response.json({ error }, { status })
const normal = (email: string) => email.trim().toLowerCase()

/** A database refusal as the caller should see it; anything unexpected is logged, not shown. */
function refusal(error: DbError): Response {
  switch (error.code) {
    case '42501':
      return refuse(403, error.message)
    case 'PT429': // the daily limit (supabase/schemas/limits.sql); the message says when to try again
      return refuse(429, error.message)
    default:
      console.error('delete-account: database error', error.code, error.message)
      return refuse(500, 'Your account could not be deleted. Nothing was changed. Try again.')
  }
}

export async function handleDeleteAccount(caller: Caller, body: unknown, deps: DeleteAccountDeps): Promise<Response> {
  if (caller.clientId !== null) return refuse(403, 'Only a signed-in person can delete their account')

  const request = DeleteRequest.safeParse(body)
  if (!request.success) return refuse(400, 'Type your email to confirm')

  const account = await deps.readAccount(caller.id)
  if (account.error) {
    console.error('delete-account: account lookup failed', account.error.message)
    return refuse(502, 'Your account could not be checked. Nothing was changed. Try again.')
  }
  // Already deleted, by an earlier attempt whose answer was lost.
  if (!account.data) return Response.json({ deleted: true, projects: 0 })
  if (!account.data.email) return refuse(400, 'This account has no email to confirm with')
  if (normal(request.data.email) !== normal(account.data.email)) {
    return refuse(400, 'That is not the email of this account')
  }

  const started = await deps.begin()
  if (started.error) return refusal(started.error)
  const summary = Summary.safeParse(started.data)
  if (!summary.success) {
    console.error('delete-account: unexpected summary', summary.error.message)
    return refuse(500, 'Your account could not be deleted. Nothing was changed. Try again.')
  }

  let deleted = 0
  for (const project of summary.data.owned) {
    const result = await deps.deleteProject(project.id)
    if (result.error) {
      console.error('delete-account: project delete failed', result.error.code, result.error.message)
      const done = deleted === 0 ? 'None of your projects were deleted' : `${deleted} of your ${summary.data.owned.length} projects were deleted`
      return refuse(500, `${done}, and your account was not. Try again.`)
    }
    deleted++
  }

  const removed = await deps.deleteUser(caller.id)
  if (removed.error && removed.error.status !== 404) {
    console.error('delete-account: account delete failed', removed.error.status, removed.error.message)
    return refuse(502, deleted === 0 ? 'Your account could not be deleted. Try again.' : 'Your projects were deleted, but your account could not be. Try again.')
  }
  return Response.json({ deleted: true, projects: deleted })
}
