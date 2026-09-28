import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import { withSupabase } from 'npm:@supabase/server@1.6.0'
import { isAuthSessionMissingError, type SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { handleDeleteAccount } from './handler.ts'

// Called by the app for a signed-in person, so `verify_jwt` stays on. The
// caller's token scopes `ctx.supabase` to them; `ctx.supabaseAdmin` uses the
// function's own secret key from its environment, which never leaves it, and
// is used only to read the account's email and to delete the account.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const deleteAccount = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
  const clientId = ctx.jwtClaims?.client_id
  const db: SupabaseClient = ctx.supabase
  const admin: SupabaseClient = ctx.supabaseAdmin
  return handleDeleteAccount(
    { id: ctx.userClaims!.id, clientId: typeof clientId === 'string' && clientId !== '' ? clientId : null },
    await req.json().catch(() => null),
    {
      // Auth's own check of the token: a session that has ended is reported
      // as a missing session, or refused with 401 or 403.
      checkSession: async () => {
        const { error } = await db.auth.getUser()
        if (!error) return 'live'
        if (isAuthSessionMissingError(error) || error.status === 401 || error.status === 403) return 'ended'
        return { error }
      },
      readAccount: async (userId) => {
        const { data, error } = await admin.auth.admin.getUserById(userId)
        if (error?.status === 404) return { data: null, error: null }
        if (error) return { data: null, error }
        return { data: { email: data.user.email ?? null }, error: null }
      },
      begin: async () => await db.rpc('begin_account_deletion'),
      deleteProject: async (projectId) => await db.rpc('delete_project', { project_id: projectId }),
      deleteUser: async (userId) => await admin.auth.admin.deleteUser(userId),
    },
  )
})

export default {
  async fetch(req: Request): Promise<Response> {
    // Browsers ask first; the answer carries no data.
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const response = await deleteAccount(req)
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value)
    return response
  },
}
