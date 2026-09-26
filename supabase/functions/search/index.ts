import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import { withSupabase } from 'npm:@supabase/server@1.6.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { handleSearch } from './handler.ts'

// Called by the app and by agents for a signed-in person, so `verify_jwt`
// stays on and the user's token scopes the database client to them.

// The Edge Runtime's built-in models. Its type file above declares this
// global, but `deno check` does not apply global declarations from a remote
// module, so the one call used here is declared locally.
declare const Supabase: {
  ai: { Session: new (model: string) => { run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown> } }
}

const model = new Supabase.ai.Session('gte-small')

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const search = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
  // Scoped to the signed-in person (RLS), as in the MCP server's tools.
  const supabase: SupabaseClient = ctx.supabase
  return handleSearch(await req.json().catch(() => null), {
    embed: async (text) => (await model.run(text, { mean_pool: true, normalize: true })) as number[],
    hybridSearch: async (args) => await supabase.rpc('hybrid_search', args),
  })
})

export default {
  async fetch(req: Request): Promise<Response> {
    // Browsers ask first; the answer carries no data.
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const response = await search(req)
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value)
    return response
  },
}
