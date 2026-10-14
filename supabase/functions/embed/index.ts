import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import postgres from 'npm:postgres@3.4.9'
import { withSupabase } from 'npm:@supabase/server@1.6.0'
import { z } from 'npm:zod@4.4.3'

import { lazyEmbedder, type ModelSession } from '../_shared/embedder.ts'
import { JobSchema, processBatch } from './jobs.ts'
import { postgresStore } from './store.ts'

// Called by the database, not a person: pg_cron sends batches of queued files
// (private.process_file_passages) with a secret key on `apikey`. So
// `verify_jwt` is off in config.toml and the key is checked here.

// The Edge Runtime's built-in models. Its type file above declares this
// global, but `deno check` does not apply global declarations from a remote
// module, so the one call used here is declared locally.
declare const Supabase: { ai: { Session: new (model: string) => ModelSession } }

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!)
const store = postgresStore(sql)
// Loaded on the first job, so a failed load fails that batch's jobs (they
// return to the queue) instead of stopping the worker.
const embed = lazyEmbedder(() => new Supabase.ai.Session('gte-small'))

export default {
  // 'secret:*' accepts any of the project's secret keys, so the database can
  // have its own (a bare 'secret' accepts only the key named `default`).
  fetch: withSupabase({ auth: 'secret:*' }, async (req) => {
    if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
    const jobs = z.array(JobSchema).safeParse(await req.json().catch(() => null))
    if (!jobs.success) return new Response(`invalid request body: ${jobs.error.message}`, { status: 400 })

    // The runtime fires `beforeunload` just before it stops the worker, with
    // the reason: "cpu" when the request has used most of its CPU time.
    const stopping = new AbortController()
    addEventListener('beforeunload', (event) => stopping.abort((event as CustomEvent).detail?.reason ?? 'worker stopped'))
    const outcome = await processBatch(jobs.data, store, embed, stopping.signal)

    console.log('finished processing jobs:', { completed: outcome.completed.length, failed: outcome.failed.length })
    return Response.json(outcome, {
      headers: {
        'x-completed-jobs': String(outcome.completed.length),
        'x-failed-jobs': String(outcome.failed.length),
      },
    })
  }),
}
