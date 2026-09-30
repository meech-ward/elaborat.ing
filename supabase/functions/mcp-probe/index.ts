// Temporary host capability probe, remove after testing (with the Worker's
// /mcp-probe route, the app's /embed-probe page and [functions.mcp-probe] in
// supabase/config.toml). See server.ts.
import { createProbeHandler } from './server.ts'

// The Edge Runtime's way to finish work after the response is sent.
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void }

Deno.serve(createProbeHandler({ fetch, background: (work) => EdgeRuntime.waitUntil(work) }))
