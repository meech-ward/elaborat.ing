import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// One independently scoped credential, supplied through the environment. Nothing
// is written to the checkout or printed into logs/command arguments.
const [target, ...args] = process.argv.slice(2)
if ((target !== 'cloudflare' && target !== 'supabase') ||
  (args.length > 0 && (target !== 'cloudflare' || args.length !== 1 || args[0] !== '--dry-run')))
  throw new Error('Usage: bun scripts/configure-agent-preview.ts supabase|cloudflare [--dry-run (cloudflare only)]')
const secret = process.env.AGENT_PREVIEW_SECRET?.trim()
if (secret && !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('The agent preview credential must be a generated base64url secret.')
if (target === 'cloudflare') {
  // Upload the code and optional credential in one version. A separate
  // `secret put` refuses a service with a newer unpromoted staged version.
  const command = ['bunx', 'wrangler', 'deploy', ...args]
  const deploy = async (filename?: string) => {
    const child = Bun.spawn([...command, ...(filename ? ['--secrets-file', filename] : [])],
      { stdout: 'inherit', stderr: 'inherit' })
    if (await child.exited !== 0) throw new Error('The Cloudflare app could not be deployed.')
  }
  if (secret) {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-preview-secret-'))
    try {
      const filename = path.join(directory, 'preview.json')
      await writeFile(filename, JSON.stringify({ AGENT_PREVIEW_SECRET: secret }), { mode: 0o600 })
      await deploy(filename)
    } finally { await rm(directory, { recursive: true, force: true }) }
  } else {
    console.log('No agent preview service credential supplied; deploying with existing secret configuration.')
    await deploy()
  }
} else if (target === 'supabase') {
  if (!secret) {
    console.log('No agent preview service credential configured; keeping previews unavailable.')
    process.exit(0)
  }
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
}
