import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// One independently scoped credential, supplied through the environment. Nothing
// is written to the checkout or printed into logs/command arguments.
const secret = process.env.AGENT_PREVIEW_SECRET?.trim()
if (!secret) {
  console.log('No agent preview service credential configured; keeping previews unavailable.')
  process.exit(0)
}
if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('The agent preview credential must be a generated base64url secret.')
const target = process.argv[2]
if (target === 'cloudflare') {
  const child = Bun.spawn(['bunx', 'wrangler', 'secret', 'put', 'AGENT_PREVIEW_SECRET'], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
  child.stdin.write(secret)
  child.stdin.end()
  if (await child.exited !== 0) throw new Error('The Cloudflare preview credential could not be configured.')
} else if (target === 'supabase') {
  const project = process.env.SUPABASE_PROJECT_ID
  if (!project || !/^[a-z0-9]{20}$/.test(project)) throw new Error('SUPABASE_PROJECT_ID is required.')
  const endpoint = new URL(process.env.AGENT_PREVIEW_ENDPOINT || 'https://elaborat.ing/_agent-preview')
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('A fixed HTTPS preview endpoint is required.')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-preview-secret-'))
  try {
    const filename = path.join(directory, 'preview.env')
    await writeFile(filename, `AGENT_PREVIEW_SECRET=${secret}\nAGENT_PREVIEW_ENDPOINT=${endpoint.href}\n`, { mode: 0o600 })
    const child = Bun.spawn(['bunx', 'supabase@2.118.0', 'secrets', 'set', '--project-ref', project, '--env-file', filename], { stdout: 'inherit', stderr: 'inherit' })
    if (await child.exited !== 0) throw new Error('The Supabase preview credential could not be configured.')
  } finally { await rm(directory, { recursive: true, force: true }) }
} else throw new Error('Usage: bun scripts/configure-agent-preview.ts supabase|cloudflare')
