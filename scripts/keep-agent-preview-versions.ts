// Retain the current native renderer and two published builds before deploying.
// Unlike optional editor frames, a missing/corrupt retained renderer fails the
// release: the running MCP function may still request that exact build.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/mini'

const MAX_FILES = 600
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_BUILD_BYTES = 64 * 1024 * 1024
const MAX_INDEX_BYTES = 256 * 1024
const MAX_MANIFEST_BYTES = 80_000
const safeFile = z.string().check(z.maxLength(512), z.regex(/^[a-zA-Z0-9_./~-]+$/), z.refine(value =>
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..')))
const versionSchema = z.strictObject({
  folder: z.string().check(z.regex(/^agent-preview\/[a-f0-9]{16}\/$/)),
  files: z.array(safeFile).check(z.minLength(2), z.maxLength(MAX_FILES)),
})
const versionsSchema = z.strictObject({ versions: z.array(versionSchema).check(z.minLength(1), z.maxLength(10)) })
const manifestSchema = z.strictObject({ build: z.string(), entry: z.string(), assets: z.array(z.string()).check(z.maxLength(MAX_FILES)) })
type Version = z.infer<typeof versionSchema>

export function agentPreviewOrigin(value: string): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS origin without credentials, query, or path.')
  return url.origin
}

function parseVersions(bytes: Uint8Array): Version[] {
  if (bytes.byteLength > MAX_INDEX_BYTES) throw new Error('The renderer version index exceeds its byte budget.')
  const index = versionsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (new Set(index.versions.map(version => version.folder)).size !== index.versions.length)
    throw new Error('The renderer version index repeats a build.')
  for (const version of index.versions) {
    if (new Set(version.files).size !== version.files.length || !version.files.includes('manifest.json') || !version.files.includes('index.html'))
      throw new Error('A renderer version repeats files or lacks its entry/manifest.')
  }
  return index.versions
}

async function boundedFile(filename: string, limit: number): Promise<Uint8Array> {
  if ((await stat(filename)).size > limit) throw new Error('A renderer file exceeds its byte budget.')
  const bytes = await readFile(filename)
  if (bytes.byteLength > limit) throw new Error('A renderer file exceeds its byte budget.')
  return bytes
}

async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new Error('A renderer download exceeds its byte budget.')
  if (!response.body) throw new Error('A renderer download has no body.')
  const reader = response.body.getReader()
  let size = 0
  const parts: Uint8Array[] = []
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if ((size += part.value.byteLength) > limit) { await reader.cancel(); throw new Error('A renderer download exceeds its byte budget.') }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}

function verify(version: Version, files: ReadonlyMap<string, Uint8Array>) {
  const manifestBytes = files.get('manifest.json')!
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('A renderer manifest exceeds its byte budget.')
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
  const build = version.folder.split('/')[1]
  const names = version.files.filter(file => file !== 'manifest.json').sort()
  const expectedAssets = names.map(file => `/${version.folder}${file}`)
  if (manifest.build !== build || manifest.entry !== `/${version.folder}index.html` ||
    JSON.stringify([...manifest.assets].sort()) !== JSON.stringify(expectedAssets))
    throw new Error(`The renderer manifest does not match ${version.folder}.`)
  const digest = createHash('sha256')
  let size = 0
  for (const name of names) {
    const bytes = files.get(name)!
    if (bytes.byteLength > MAX_FILE_BYTES || (size += bytes.byteLength) > MAX_BUILD_BYTES)
      throw new Error('A renderer build exceeds its byte budget.')
    digest.update(name).update('\0').update(bytes).update('\0')
  }
  if (digest.digest('hex').slice(0, 16) !== build) throw new Error(`The renderer content hash does not match ${version.folder}.`)
}

async function readLocal(outputDir: string, version: Version): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (const file of version.files) {
    const bytes = await boundedFile(path.join(outputDir, version.folder, file), file === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES)
    if ((total += bytes.byteLength) > MAX_BUILD_BYTES) throw new Error('A renderer build exceeds its byte budget.')
    files.set(file, bytes)
  }
  verify(version, files)
  return files
}

async function download(fetcher: typeof fetch, origin: string, resource: string): Promise<Response> {
  const response = await fetcher(new URL(resource, `${origin}/`), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Renderer download failed (${response.status}) for ${resource}.`)
  return response
}

async function downloadVersion(fetcher: typeof fetch, origin: string, outputDir: string, version: Version) {
  const files = new Map<string, Uint8Array>()
  let next = 0, total = 0
  // Stop scheduling new files after a failure, then await all outstanding work.
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(4, version.files.length) }, async () => {
    while (!failure && next < version.files.length) {
      const file = version.files[next++]
      try {
        // Cloudflare Assets redirects index.html to its directory URL. Request
        // that one canonical alias directly while still refusing all redirects.
        const resource = file === 'index.html' ? version.folder : `${version.folder}${file}`
        const response = await download(fetcher, origin, resource)
        const bytes = await boundedResponse(response, file === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES)
        if ((total += bytes.byteLength) > MAX_BUILD_BYTES) throw new Error('A renderer build exceeds its byte budget.')
        files.set(file, bytes)
      } catch (error) { failure = error }
    }
  }))
  if (failure) throw failure
  verify(version, files)
  const parent = path.join(outputDir, 'agent-preview')
  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(path.join(parent, '.retained-'))
  try {
    for (const [file, bytes] of files) {
      const filename = path.join(temporary, file)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, bytes)
    }
    await rename(temporary, path.join(outputDir, version.folder))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Failure leaves the existing index untouched; never silently drop a published renderer. */
export async function keepAgentPreviewVersions(outputDir: string, publishedOrigin: string, fetcher: typeof fetch = fetch) {
  const origin = agentPreviewOrigin(publishedOrigin)
  const indexPath = path.join(outputDir, 'agent-preview/versions.json')
  const local = parseVersions(await boundedFile(indexPath, MAX_INDEX_BYTES))
  await readLocal(outputDir, local[0])
  const remoteResponse = await fetcher(new URL('/agent-preview/versions.json', origin), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  })
  let remote: Version[]
  if (remoteResponse.status === 404) remote = local.slice(1)
  else {
    if (!remoteResponse.ok) throw new Error(`Renderer version lookup failed (${remoteResponse.status}).`)
    remote = parseVersions(await boundedResponse(remoteResponse, MAX_INDEX_BYTES))
  }
  const selected: Version[] = []
  for (const version of [local[0], ...remote]) {
    const prior = selected.find(item => item.folder === version.folder)
    if (prior) {
      if (JSON.stringify([...prior.files].sort()) !== JSON.stringify([...version.files].sort())) throw new Error('A renderer version has conflicting file lists.')
      continue
    }
    selected.push(version)
    if (selected.length === 3) break
  }
  for (const version of selected.slice(1)) {
    let exists = true
    try { await stat(path.join(outputDir, version.folder)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (exists) await readLocal(outputDir, version)
    else await downloadVersion(fetcher, origin, outputDir, version)
  }
  const temporaryIndex = `${indexPath}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryIndex, `${JSON.stringify({ versions: selected })}\n`)
    await rename(temporaryIndex, indexPath)
  } finally { await rm(temporaryIndex, { force: true }) }
  return { kept: selected.map(version => version.folder) }
}

if (import.meta.main) {
  const origin = process.argv[2]
  if (!origin) throw new Error('Usage: bun scripts/keep-agent-preview-versions.ts https://<app origin> [output directory]')
  const outputDir = process.argv[3] ?? path.join(import.meta.dirname, '..', 'dist')
  const { kept } = await keepAgentPreviewVersions(outputDir, origin)
  console.log(`Agent preview versions to deploy, newest first:\n${kept.map(folder => `  ${folder}`).join('\n')}`)
}
