import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import postgres from 'npm:postgres@3.4.9'
import { withSupabase } from 'npm:@supabase/server@1.6.0'
import { z } from 'npm:zod@4.4.3'

import { JobSchema, processJobs } from './jobs.ts'
import { postgresStore } from './store.ts'

// Called by the database, not a person: pg_cron sends batches of queued files
// (private.process_file_passages) with a secret key on `apikey`. So
// `verify_jwt` is off in config.toml and the key is checked here.

// The Edge Runtime's built-in models. Its type file above declares this
// global, but `deno check` does not apply global declarations from a remote
// module, so the one call used here is declared locally.
declare const Supabase: {
  ai: { Session: new (model: string) => { run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown> } }
}

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!)
const store = postgresStore(sql)
const model = new Supabase.ai.Session('gte-small')
const embed = async (text: string) => (await model.run(text, { mean_pool: true, normalize: true })) as number[]

export default {
  // 'secret:*' accepts any of the project's secret keys, so the database can
  // have its own (a bare 'secret' accepts only the key named `default`).
  fetch: withSupabase({ auth: 'secret:*' }, async (req) => {
    if (req.method !== 'POST') return new Response('expected POST request', { status: 405 })
    const jobs = z.array(JobSchema).safeParse(await req.json().catch(() => null))
    if (!jobs.success) return new Response(`invalid request body: ${jobs.error.message}`, { status: 400 })

    const pending = [...jobs.data]
    const outcome = await Promise.race([
      processJobs(pending, store, embed),
      // If the worker is stopped (its wall clock limit, say), unfinished jobs
      // return to the queue when their visibility timeout ends.
      new Promise<never>((_, reject) =>
        addEventListener('beforeunload', (event) => reject(new Error((event as CustomEvent).detail?.reason ?? 'worker stopped')))
      ),
    ]).catch((error: unknown) => ({
      completed: [],
      failed: pending.map((job) => ({ ...job, error: error instanceof Error ? error.message : String(error) })),
    }))

    console.log('finished processing jobs:', { completed: outcome.completed.length, failed: outcome.failed.length })
    return Response.json(outcome, {
      headers: {
        'x-completed-jobs': String(outcome.completed.length),
        'x-failed-jobs': String(outcome.failed.length),
      },
    })
  }),
}
