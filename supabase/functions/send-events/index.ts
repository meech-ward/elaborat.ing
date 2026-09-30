import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import postgres from 'npm:postgres@3.4.9'
import { withSupabase } from 'npm:@supabase/server@1.6.0'

import { postToCallback } from '../_shared/callbacks.ts'
import { deliverDue } from './deliver.ts'
import { postgresQueue } from './store.ts'

// Called by the database, not a person: a comment that matches a subscription
// (private.queue_comment_events) and the once-a-minute sweep for retries
// (private.sweep_comment_events) call it with a secret key on `apikey`. So
// `verify_jwt` is off in config.toml and the key is checked here, as in embed.

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!)
const queue = postgresQueue(sql)

export default {
  // 'secret:*' accepts any of the project's secret keys, so the database can have its own.
  fetch: withSupabase({ auth: 'secret:*' }, async (req) => {
    if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
    const counts = await deliverDue(queue, (url, headers, body) => postToCallback(url, headers, body))
    console.log(JSON.stringify({ events: 'send-events', step: 'run', ...counts }))
    return Response.json(counts)
  }),
}
