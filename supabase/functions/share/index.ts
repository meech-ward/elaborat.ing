import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import { withSupabase } from 'npm:@supabase/server@1.6.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { handleShare } from './handler.ts'

// Called by the app for a signed-in person, so `verify_jwt` stays on. The
// caller's token scopes `ctx.supabase` to them; `ctx.supabaseAdmin` uses the
// function's own secret key from its environment, which never leaves it.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const share = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
  const clientId = ctx.jwtClaims?.client_id
  const db: SupabaseClient = ctx.supabase
  const admin: SupabaseClient = ctx.supabaseAdmin
  return handleShare(
    { id: ctx.userClaims!.id, clientId: typeof clientId === 'string' && clientId !== '' ? clientId : null },
    await req.json().catch(() => null),
    {
      readProject: async (projectId) => await db.from('projects').select('owner_id, title').eq('id', projectId).maybeSingle(),
      prepare: async (args) => await admin.rpc('prepare_email_invitation', args),
      shareProject: async (args) => await db.rpc('share_project', args),
      inviteUserByEmail: async (email, options) => await admin.auth.admin.inviteUserByEmail(email, options),
      record: async (args) => await admin.rpc('record_email_invitation', args),
      redirectTo: 'https://elaborat.ing/',
    },
  )
})

export default {
  async fetch(req: Request): Promise<Response> {
    // Browsers ask first; the answer carries no data.
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const response = await share(req)
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value)
    return response
  },
}
