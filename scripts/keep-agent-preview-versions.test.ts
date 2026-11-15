import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { agentPreviewOrigin, keepAgentPreviewVersions } from './keep-agent-preview-versions.ts'

const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }) })
const encode = (text: string) => new TextEncoder().encode(text)
function version(label: string, extra: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries({ 'index.html': encode(`<html>${label}</html>`),
    'assets/main.js': encode(`console.log(${JSON.stringify(label)})`),
    'assets/engine.wasm': new Uint8Array([0, 97, 115, 109, label.length]), ...extra }))
  const names = [...files.keys()].sort()
  const hash = createHash('sha256')
  for (const name of names) hash.update(name).update('\0').update(files.get(name)!).update('\0')
  const build = hash.digest('hex').slice(0, 16)
  const folder = `agent-preview/${build}/`
  const manifest = { build, entry: `/${folder}index.html`, assets: names.map(file => `/${folder}${file}`) }
  files.set('manifest.json', encode(JSON.stringify(manifest)))
  return { folder, files: [...files.keys()], bytes: files, manifest }
}
type FixtureVersion = ReturnType<typeof version>
const descriptor = (input: FixtureVersion) => ({ folder: input.folder, files: input.files })
async function local(input: FixtureVersion) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'elaborating-preview-retain-'))
  temporary.push(directory)
  for (const [file, bytes] of input.bytes) {
    const filename = path.join(directory, input.folder, file)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, bytes)
  }
  const index = JSON.stringify({ versions: [descriptor(input)] })
  await writeFile(path.join(directory, 'agent-preview/versions.json'), index)
  return { directory, index }
}
function remote(versions: FixtureVersion[], override?: (resource: string) => Response | undefined) {
  const requested: string[] = []
  let active = 0, maximum = 0
  const fetcher: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requested.push(url.pathname)
    expect(url.origin).toBe('https://published.test')
    expect(init?.redirect).toBe('error')
    expect(init?.cache).toBe('no-store')
    if (url.pathname === '/agent-preview/versions.json') return Response.json({ versions: versions.map(descriptor) })
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 1))
    active--
    const replaced = override?.(url.pathname)
    if (replaced) return replaced
    for (const item of versions) {
      if (!url.pathname.startsWith(`/${item.folder}`)) continue
      const bytes = item.bytes.get(url.pathname.slice(item.folder.length + 1))
      if (bytes) return new Response(bytes)
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch
  return { fetcher, requested, maximum: () => maximum }
}

test('retains current plus two published builds, copies binary assets exactly, and bounds concurrent downloads', async () => {
  const current = version('current')
  const old = version('old', { 'fonts/a.woff2': encode('font'), 'assets/worker~shared.js': encode('other') })
  const older = version('older')
  const obsolete = version('obsolete')
  const { directory } = await local(current)
  const published = remote([old, older, obsolete])
  expect(await keepAgentPreviewVersions(directory, 'https://published.test', published.fetcher))
    .toEqual({ kept: [current.folder, old.folder, older.folder] })
  expect(published.maximum()).toBeGreaterThan(1)
  expect(published.maximum()).toBeLessThanOrEqual(4)
  expect(published.requested.some(resource => resource.startsWith(`/${obsolete.folder}`))).toBe(false)
  for (const item of [current, old, older]) for (const [file, bytes] of item.bytes)
    expect(new Uint8Array(await readFile(path.join(directory, item.folder, file)))).toEqual(bytes)
  expect(JSON.parse(await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')))
    .toEqual({ versions: [current, old, older].map(descriptor) })
  // Repeating retention verifies existing local builds without downloading them again.
  const again = remote([old, older])
  await keepAgentPreviewVersions(directory, 'https://published.test/', again.fetcher)
  expect(again.requested).toEqual(['/agent-preview/versions.json'])
})

test('the first deployment accepts a missing published index, while other lookup errors fail closed', async () => {
  const current = version('first')
  const { directory, index } = await local(current)
  expect(await keepAgentPreviewVersions(directory, 'https://published.test', (async () => new Response('missing', { status: 404 })) as typeof fetch))
    .toEqual({ kept: [current.folder] })
  const retainedIndex = await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')
  expect(JSON.parse(retainedIndex)).toEqual(JSON.parse(index))
  await expect(keepAgentPreviewVersions(directory, 'https://published.test', (async () => new Response('error', { status: 500 })) as typeof fetch)).rejects.toThrow('lookup failed')
  expect(await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')).toBe(retainedIndex)
})

test('a corrupt or missing published file aborts retention and leaves the current index untouched', async () => {
  const current = version('new')
  const old = version('old')
  for (const replacement of [new Response(encode('tampered')), new Response('missing', { status: 404 })]) {
    const { directory, index } = await local(current)
    const published = remote([old], resource => resource.endsWith('/assets/main.js') ? replacement : undefined)
    await expect(keepAgentPreviewVersions(directory, 'https://published.test', published.fetcher)).rejects.toThrow()
    expect(await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')).toBe(index)
    expect((await readdir(path.join(directory, 'agent-preview'))).sort()).toEqual([current.folder.split('/')[1], 'versions.json'].sort())
  }
})

test('manifest identity, file membership and asset URLs must match the content-addressed build', async () => {
  const current = version('new')
  const old = version('old')
  for (const manifest of [
    { ...old.manifest, build: 'ffffffffffffffff' }, { ...old.manifest, entry: 'https://evil.test' },
    { ...old.manifest, assets: [...old.manifest.assets, 'https://evil.test/code.js'] },
    { ...old.manifest, assets: old.manifest.assets.slice(1) }, { ...old.manifest, extra: 'unexpected' },
  ]) {
    const { directory, index } = await local(current)
    const published = remote([old], resource => resource.endsWith('/manifest.json') ? Response.json(manifest) : undefined)
    await expect(keepAgentPreviewVersions(directory, 'https://published.test', published.fetcher)).rejects.toThrow()
    expect(await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')).toBe(index)
  }
})

test('version indexes reject traversal, repeated files/builds, excessive files and invalid JSON before downloading files', async () => {
  const current = version('new')
  const old = version('old')
  const valid = descriptor(old)
  for (const versions of [
    [{ ...valid, files: [...valid.files, '../escape.js'] }],
    [{ ...valid, files: [...valid.files, '/absolute.js'] }],
    [{ ...valid, files: [...valid.files, 'assets/%2e%2e/escape.js'] }],
    [{ ...valid, folder: 'agent-preview/../../' }],
    [{ ...valid, files: [...valid.files, valid.files[0]] }], [valid, valid],
    [{ ...valid, files: [...valid.files, ...Array.from({ length: 601 }, (_, i) => `assets/${i}.js`)] }],
  ]) {
    const { directory } = await local(current)
    let calls = 0
    await expect(keepAgentPreviewVersions(directory, 'https://published.test', (async () => { calls++; return Response.json({ versions }) }) as typeof fetch)).rejects.toThrow()
    expect(calls).toBe(1)
  }
  const { directory } = await local(current)
  await expect(keepAgentPreviewVersions(directory, 'https://published.test', (async () => new Response('not JSON')) as typeof fetch)).rejects.toThrow()
})

test('advertised and actual byte limits are enforced before staging downloads', async () => {
  const current = version('new')
  const old = version('old')
  for (const replacement of [
    new Response('x', { headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) } }),
    new Response('x'.repeat(80_001)),
  ]) {
    const { directory, index } = await local(current)
    const published = remote([old], resource => resource.endsWith('/manifest.json') ? replacement : undefined)
    await expect(keepAgentPreviewVersions(directory, 'https://published.test', published.fetcher)).rejects.toThrow('byte budget')
    expect(await readFile(path.join(directory, 'agent-preview/versions.json'), 'utf8')).toBe(index)
  }
})

test('local current content must also verify before any network lookup', async () => {
  const current = version('current')
  const { directory } = await local(current)
  await writeFile(path.join(directory, current.folder, 'assets/main.js'), 'changed')
  await expect(keepAgentPreviewVersions(directory, 'https://published.test', (async () => { throw new Error('must not fetch') }) as typeof fetch)).rejects.toThrow('content hash')
})

test('origins permit HTTPS and loopback HTTP while refusing paths, credentials, queries and remote cleartext', () => {
  expect(agentPreviewOrigin('https://published.test/')).toBe('https://published.test')
  expect(agentPreviewOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  expect(agentPreviewOrigin('http://localhost:3000/')).toBe('http://localhost:3000')
  expect(agentPreviewOrigin('http://[::1]:3000/')).toBe('http://[::1]:3000')
  for (const value of ['https://user:pass@published.test', 'https://published.test/path', 'https://published.test?token=1',
    'https://published.test#fragment', 'http://published.test', 'file:///tmp', 'not a URL']) expect(() => agentPreviewOrigin(value)).toThrow()
})
