import { z } from 'npm:zod@4.4.3'

// Share a project by email, for its signed-in owner. An email that already has
// an account gets the usual invitation (public.share_project, as the caller).
// An email without one gets an account created through Auth's invite, which
// sends the invitation email, and the invitation is recorded for it. Either
// way the invitation grants nothing until the person signs in and accepts it,
// and the answer is the same.
//
// Only people share by email: a token issued to an OAuth client (an agent) is
// refused. Looking up an account by email, counting the owner's daily limit and
// recording an invitation for a new account run with the service role, through
// database functions only it may call, after the ownership check here.

export const ShareRequest = z.object({
  projectId: z.uuid(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(['viewer', 'commenter', 'editor']),
})

export type Role = z.infer<typeof ShareRequest>['role']

/** Who is calling, from their verified access token. */
export type Caller = {
  id: string
  /** Set when the token was issued to an OAuth client, such as an agent. */
  clientId: string | null
}

type DbError = { code?: string; message: string }
type Answer<T> = { data: T | null; error: DbError | null }

export type Prepared = { member_id: string | null; title: string; inviter_email: string | null }

export type ShareDeps = {
  /** The project's owner and title as the caller reads them (RLS); null when they cannot read it. */
  readProject: (projectId: string) => Promise<Answer<{ owner_id: string; title: string }>>
  /** public.prepare_email_invitation, with the service role. */
  prepare: (args: { inviter_id: string; project_id: string; email: string }) => Promise<Answer<Prepared>>
  /** public.share_project as the caller: the invitation for an existing account. */
  shareProject: (args: { project_id: string; member_id: string; member_role: Role }) => Promise<Answer<unknown>>
  /** Auth's admin invite, with the service role: creates the account and sends the email. */
  inviteUserByEmail: (
    email: string,
    options: { redirectTo: string; data: { invited_by: string; project_title: string } },
  ) => Promise<{ data: { user: { id: string } | null }; error: { message: string; code?: string; status?: number } | null }>
  /** public.record_email_invitation, with the service role. */
  record: (args: { inviter_id: string; project_id: string; member_id: string; member_role: Role }) => Promise<Answer<unknown>>
  /** Where the invitation email's link lands once the person is signed in. */
  redirectTo: string
}

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** A database refusal as the caller should see it; anything unexpected is logged, not shown. */
function refusal(error: DbError): Response {
  switch (error.code) {
    case '42501':
      return refuse(403, error.message)
    case 'PT429': // a per-account limit (supabase/schemas/limits.sql); the message says when to try again
      return refuse(429, error.message)
    case '22023':
      return refuse(400, error.message)
    default:
      console.error('share: database error', error.code, error.message)
      return refuse(500, 'The project could not be shared. Try again.')
  }
}

export async function handleShare(caller: Caller, body: unknown, deps: ShareDeps): Promise<Response> {
  if (caller.clientId !== null) return refuse(403, 'Only a signed-in person can invite people by email')

  const request = ShareRequest.safeParse(body)
  if (!request.success) return refuse(400, request.error.issues.some((issue) => issue.path[0] === 'email') ? 'Enter an email address' : request.error.message)
  const { projectId, email, role } = request.data

  // Ownership, as the caller: RLS shows them the project only if they can read it.
  const project = await deps.readProject(projectId)
  if (project.error) return refusal(project.error)
  if (!project.data || project.data.owner_id !== caller.id) return refuse(403, 'Only the project owner can change sharing')

  const prepared = await deps.prepare({ inviter_id: caller.id, project_id: projectId, email })
  if (prepared.error || !prepared.data) return refusal(prepared.error ?? { message: 'No answer' })
  const { member_id: existing, title, inviter_email: inviterEmail } = prepared.data

  if (existing) {
    const shared = await deps.shareProject({ project_id: projectId, member_id: existing, member_role: role })
    if (shared.error) return refusal(shared.error)
    return Response.json({ projectId, email, role })
  }

  const invited = await deps.inviteUserByEmail(email, {
    redirectTo: deps.redirectTo,
    data: { invited_by: inviterEmail ?? 'Someone', project_title: title },
  })
  if (invited.error || !invited.data.user) {
    const code = invited.error?.code
    if (code === 'email_exists') return refuse(409, 'That email has just joined. Invite it again.')
    if (code === 'over_email_send_rate_limit' || invited.error?.status === 429) {
      return refuse(429, 'Too many emails were sent just now. Try again later.')
    }
    console.error('share: invite failed', code, invited.error?.message)
    return refuse(502, 'The invitation email could not be sent. Try again later.')
  }

  const recorded = await deps.record({ inviter_id: caller.id, project_id: projectId, member_id: invited.data.user.id, member_role: role })
  if (recorded.error) return refusal(recorded.error)
  return Response.json({ projectId, email, role })
}
