import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'
import postgres from 'npm:postgres@3.4.9'
import { withSupabase } from 'npm:@supabase/server@1.6.0'
import { renderPreviewThroughWorker } from '../_shared/drawingPreview.ts'
import { PREVIEW_BUILD } from '../mcp-server/tools/previewManifest.ts'
import { processNextDrawingPreview } from './jobs.ts'
import { postgresPreviewStore } from './store.ts'

// pg_cron calls this with the existing Vault embed key on apikey. The gateway
// cannot verify secret keys as user JWTs, so withSupabase performs this gate.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, connect_timeout: 10, idle_timeout: 20,
  connection: { statement_timeout: 10_000, lock_timeout: 2_000 } })
const store = postgresPreviewStore(sql)

export default {
  fetch: withSupabase({ auth: 'secret:*' }, async request => {
    if (request.method !== 'POST') return new Response('expected POST request', { status: 405 })
    // Missing configuration must not spend the queued generation's attempts.
    const secret = Deno.env.get('AGENT_PREVIEW_SECRET')?.trim()
    const endpoint = Deno.env.get('AGENT_PREVIEW_ENDPOINT')?.trim() || 'https://elaborat.ing/_agent-preview'
    let configured = false
    try {
      const url = new URL(endpoint)
      configured = !!secret && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    } catch { /* An invalid deployment setting keeps the background service unavailable. */ }
    if (!configured) {
      // An optional unconfigured installation must not dispatch every five
      // seconds while the same saved generation remains pending.
      await store.deferDispatch(300).catch(() => {})
      return Response.json({ status: 'unavailable' }, { status: 503 })
    }
    const stopping = new AbortController()
    const stop = () => stopping.abort()
    const cancel = () => stopping.abort()
    addEventListener('beforeunload', stop)
    request.signal.addEventListener('abort', cancel, { once: true })
    if (request.signal.aborted) cancel()
    try {
      const outcome = await processNextDrawingPreview(store,
        (job, signal) => renderPreviewThroughWorker(job, signal, { secret: secret!, endpoint }),
        { rendererBuild: PREVIEW_BUILD, signal: stopping.signal })
      console.log(JSON.stringify({ worker: 'drawing-previews', ...outcome }))
      return Response.json(outcome)
    } finally {
      removeEventListener('beforeunload', stop)
      request.signal.removeEventListener('abort', cancel)
    }
  }),
}
