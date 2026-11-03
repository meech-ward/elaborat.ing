import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'
import { withSupabase } from 'npm:@supabase/server@1.6.0'
import { handleFileShare, shareHeaders } from './handler.ts'
import { fileShareDependencies } from './dependencies.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const read = withSupabase({ auth: 'none' }, async (req, ctx) => {
  if (req.method !== 'POST') return Response.json({ error: 'Expected POST request' }, { status: 405, headers: shareHeaders })
  // Tokens are supplied in a bounded body, never a request URL or log entry.
  if (Number(req.headers.get('content-length')) > 1024) return Response.json({ error: 'Shared file unavailable' }, { status: 404, headers: shareHeaders })
  let body: unknown = null
  const reader = req.body?.getReader()
  if (reader) {
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > 1024) { await reader.cancel(); break }
        chunks.push(chunk.value)
      }
      if (length <= 1024) {
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        body = JSON.parse(new TextDecoder().decode(bytes))
      }
    } catch { /* invalid input has the same unavailable response */ }
    finally { reader.releaseLock() }
  }
  return await handleFileShare(body, fileShareDependencies(ctx.supabaseAdmin))
})
export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, ...shareHeaders } })
    const response = await read(req)
    for (const [name, value] of Object.entries({ ...cors, ...shareHeaders })) response.headers.set(name, value)
    return response
  },
}
