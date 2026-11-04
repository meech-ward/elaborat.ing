import { assertEquals, assert, assertFalse } from 'jsr:@std/assert@1.0.19'
import { handleFileShare, SHARE_LIMITS, type FileRecord, type FileShareDeps, type ShareContext } from './handler.ts'
import { renderingReferences } from './references.ts'
import { imageDigest } from '../../../src/features/images/types.ts'

const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001'
const ROOT = 'bbbbbbbb-0000-4000-8000-000000000001'
const SHARE = 'cccccccc-0000-4000-8000-000000000001'
const ASSET = 'dddddddd-0000-4000-8000-000000000001'
const TOKEN = 'a'.repeat(64)
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
const text = (path: string, content = '# Hello'): FileRecord => ({ id: crypto.randomUUID(), path, content, version: 1, kind: 'text' })

function fake(content = '# Public', path = 'note.mdx') {
  const initial: ShareContext = { id: SHARE, file_id: ROOT, project_id: PROJECT, path, content, version: 1, revision: 3, archived: false, kind: 'text' }
  const files = new Map<string, FileRecord>()
  const downloads = new Map<string, Uint8Array>()
  const calls: Array<[string, string?]> = []
  let contexts = 0
  const deps: FileShareDeps = {
    context: token => {
      calls.push(['context', token])
      contexts++
      return Promise.resolve(token === TOKEN ? { data: initial, error: null } : { data: null, error: { code: '42501' } })
    },
    read: (token, wanted) => {
      assertEquals(token, TOKEN)
      calls.push(['read', wanted])
      return Promise.resolve({ data: files.get(wanted) ?? null, error: null })
    },
    download: key => { calls.push(['download', key]); return Promise.resolve(downloads.get(key) ?? null) },
  }
  return { initial, files, downloads, calls, deps, contexts: () => contexts }
}
async function image(path: string, bytes: Uint8Array = png, mediaType = 'image/png') {
  return { id: crypto.randomUUID(), path, content: '', version: 1, kind: 'image', asset: {
    id: ASSET, media_type: mediaType, byte_length: bytes.length, width: 1, height: 1, sha256: await imageDigest(bytes),
    object_key: `${PROJECT}/${ASSET}/original`, preview_key: `${PROJECT}/${ASSET}/preview`,
    preview_type: 'image/png', preview_byte_length: png.length,
  } } satisfies FileRecord
}
const readPaths = (calls: Array<[string, string?]>) => calls.filter(([kind]) => kind === 'read').map(([, path]) => path)

Deno.test('a public read returns only the root without project or member metadata', async () => {
  const f = fake()
  Object.assign(f.initial, { title: 'Private project title', owner_id: 'private-owner', private_comments: ['secret'] })
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), {
    share: { id: SHARE, file_id: ROOT, path: 'note.mdx', version: 1, revision: 3, archived: false },
    files: [{ id: ROOT, path: 'note.mdx', content: '# Public', version: 1 }], images: [],
  })
  assertEquals(f.contexts(), 2)
  assertEquals(response.headers.get('cache-control'), 'no-store')
  assertEquals(response.headers.get('referrer-policy'), 'no-referrer')
  assert(response.headers.get('x-robots-tag')?.includes('noindex'))
})

Deno.test('malformed tokens and extra browser paths never reach the database', async () => {
  for (const body of [null, {}, { token: 'x' }, { token: TOKEN.toUpperCase() }, { token: TOKEN, path: 'private.md' }, { token: `${TOKEN}\n` }]) {
    const f = fake()
    const response = await handleFileShare(body, f.deps)
    assertEquals(response.status, 404)
    assertEquals(await response.json(), { error: 'Shared file unavailable' })
    assertEquals(f.calls, [])
  }
})

Deno.test('invalid and revoked tokens have the same unavailable response', async () => {
  const f = fake()
  const response = await handleFileShare({ token: 'b'.repeat(64) }, f.deps)
  assertEquals(response.status, 404)
  assertEquals(await response.json(), { error: 'Shared file unavailable' })
  assertEquals(readPaths(f.calls), [])
})

Deno.test('the parser includes only literal rendering references, never ordinary links or source examples', async () => {
  const source = `import { Banner } from 'workspace:components/banner.mdx'

[Private](private.md)

![Photo](assets/a.png)

<Document src="sections/details.md" title="Details" defaultCollapsed={true} />

<Drawing src="drawings/a.excalidraw" />

<Diagram src="diagrams/a.d2" />

<Drawing src={"private.excalidraw"} />

<Document {...props} src="private.md" />

<Document src="private.md"></Document>

<Document src="../private.md" />

{/* <Document src="comment-secret.md" /> */}

\`<Drawing src="inline-secret.excalidraw" />\`

\`\`\`mdx
<Drawing src="code-secret.excalidraw" />
import { Secret } from 'workspace:private.mdx'
\`\`\`
`
  const refs = await renderingReferences(source, 'note.mdx')
  assertEquals(refs.map(ref => [ref.kind, ref.path]), [
    ['module', 'components/banner.mdx'], ['document', 'sections/details.md'],
    ['drawing', 'drawings/a.excalidraw'], ['diagram', 'diagrams/a.d2'], ['image', 'assets/a.png'],
  ])
})

Deno.test('Markdown drawing tags render, but Document tags remain MDX-only', async () => {
  const refs = await renderingReferences('<Drawing src="a.excalidraw" />\n\n<Document src="private.md" />\n\n```md\n<Diagram src="hidden.d2" />\n```', 'note.md')
  assertEquals(refs, [{ kind: 'drawing', path: 'a.excalidraw' }])
})

Deno.test('module JSX images and drawing literals resolve without computed or spread reads', async () => {
  const refs = await renderingReferences(`export const Card = () => <><img src="../assets/a.png" /><Drawing src="a.excalidraw" /><Drawing src={"hidden.excalidraw"} /><img {...props} src="../assets/hidden.png" /></>`, 'components/card.mdx')
  assertEquals(refs, [{ kind: 'drawing', path: 'a.excalidraw' }, { kind: 'image', path: 'assets/a.png' }])
})

Deno.test('nested documents, transitive workspace modules and D2 companion files load in the original project', async () => {
  const f = fake('<Document src="sections/one.mdx" />')
  f.files.set('sections/one.mdx', text('sections/one.mdx', `import { Card } from 'workspace:components/card.mdx'\n\n<Diagram src="flow.d2" />\n\n<Card />`))
  f.files.set('components/card.mdx', text('components/card.mdx', `import { Label } from 'workspace:components/label.mdx'\n\nexport const Card = () => <Label />`))
  f.files.set('components/label.mdx', text('components/label.mdx', 'export const Label = () => <span>Label</span>'))
  f.files.set('flow.d2', text('flow.d2', 'a -> b'))
  f.files.set('flow.excalidraw', text('flow.excalidraw', '{"elements":[]}'))
  f.files.set('flow.d2.json', text('flow.d2.json', '{"sourceHash":"x"}'))
  f.files.set('private.md', text('private.md', 'secret'))
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  const payload = await response.json()
  assertEquals(payload.files.map((file: FileRecord) => file.path), ['note.mdx', 'sections/one.mdx', 'components/card.mdx', 'components/label.mdx', 'flow.d2', 'flow.excalidraw', 'flow.d2.json'])
  assertFalse(JSON.stringify(payload).includes('secret'))
  assertFalse(readPaths(f.calls).includes('private.md'))
})

Deno.test('D2 without generated companions remains renderable from saved source', async () => {
  const f = fake('a -> b', 'flow.d2')
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  assertEquals((await response.json()).files.length, 1)
  assertEquals(readPaths(f.calls), ['flow.excalidraw', 'flow.d2.json'])
})

Deno.test('literal image dependencies deliver originals and safe previews without Storage identities', async () => {
  const f = fake('![Photo](../assets/a.png)', 'notes/root.md')
  const file = await image('assets/a.png')
  f.files.set(file.path, file)
  f.downloads.set(`${PROJECT}/${ASSET}/original`, png)
  f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  const payload = await response.json()
  assertEquals(payload.images[0].path, 'assets/a.png')
  assertEquals(payload.images[0].width, 1)
  assert(payload.images[0].dataURL.startsWith('data:image/png;base64,'))
  assertEquals(payload.images[0].preview, { dataURL: payload.images[0].dataURL, width: 1, height: 1 })
  assertFalse(JSON.stringify(payload).includes('object_key'))
  assertFalse(JSON.stringify(payload).includes(PROJECT))
})

Deno.test('a shared image root includes its original and preview', async () => {
  const f = fake('', 'a.png')
  Object.assign(f.initial, await image('a.png'), { id: SHARE, file_id: ROOT })
  f.downloads.set(`${PROJECT}/${ASSET}/original`, png)
  f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  assertEquals((await response.json()).images.map((image: { path: string }) => image.path), ['a.png'])
})

Deno.test('cross-project image Storage keys fail closed before any download', async () => {
  const f = fake('![Photo](a.png)', 'note.md')
  const file = await image('a.png')
  file.asset.object_key = file.asset.object_key.replace(PROJECT, ROOT)
  file.asset.preview_key = file.asset.preview_key.replace(PROJECT, ROOT)
  f.files.set(file.path, file)
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 409)
  assertEquals(f.calls.filter(([kind]) => kind === 'download'), [])
})

Deno.test('original image hashes and preview bytes are checked before sharing', async () => {
  for (const badPreview of [false, true]) {
    const f = fake('![Photo](a.png)', 'note.md')
    const file = await image('a.png')
    f.files.set(file.path, file)
    f.downloads.set(`${PROJECT}/${ASSET}/original`, badPreview ? png : png.slice(1))
    f.downloads.set(`${PROJECT}/${ASSET}/preview`, badPreview ? png.slice(1) : png)
    const response = await handleFileShare({ token: TOKEN }, f.deps)
    assertEquals(response.status, 409)
    assertFalse('files' in await response.json())
  }
})

Deno.test('SVG validation rejects scripts and external resources before responding', async () => {
  const f = fake('![Photo](a.svg)', 'note.md')
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>')
  f.files.set('a.svg', await image('a.svg', svg, 'image/svg+xml'))
  f.downloads.set(`${PROJECT}/${ASSET}/original`, svg)
  f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 409)
  assertFalse('files' in await response.json())
})

Deno.test('validated SVGs and animated GIFs retain original bytes while exposing only image pixels', async () => {
  const gif = new Uint8Array(50)
  gif.set(new TextEncoder().encode('GIF89a'))
  const view = new DataView(gif.buffer)
  view.setUint16(6, 1, true); view.setUint16(8, 1, true)
  gif[10] = 128; gif.set([255, 255, 255], 16)
  for (const at of [19, 34]) {
    gif[at] = 44; view.setUint16(at + 5, 1, true); view.setUint16(at + 7, 1, true)
    gif.set([0, 2, 2, 68, 1, 0], at + 9)
  }
  gif[49] = 59
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>')
  for (const [path, original, mediaType] of [['a.gif', gif, 'image/gif'], ['a.svg', svg, 'image/svg+xml']] as const) {
    const f = fake(`![Photo](${path})`, 'note.md')
    const file = await image(path, original, mediaType)
    // Image payloads can never carry a private asset JSON or metadata as text.
    file.content = 'object_key private storage identity'
    f.files.set(path, file)
    f.downloads.set(`${PROJECT}/${ASSET}/original`, original)
    f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
    const response = await handleFileShare({ token: TOKEN }, f.deps)
    assertEquals(response.status, 200)
    const payload = await response.json()
    assertEquals(payload.images[0].dataURL, `data:${mediaType};base64,${btoa(String.fromCharCode(...original))}`)
    assertEquals(payload.files.find((file: FileRecord) => file.path === path).content, '')
    assertFalse(JSON.stringify(payload).includes('object_key'))
  }
})

Deno.test('missing literal dependencies fail visibly instead of exposing a partial document', async () => {
  const f = fake('<Document src="missing.md" />')
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 409)
  assertFalse('files' in await response.json())
})

Deno.test('a service read returning a different path cannot expand authority', async () => {
  const f = fake('<Document src="allowed.md" />')
  f.deps.read = () => Promise.resolve({ data: text('private.md', 'secret'), error: null })
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 409)
  assertFalse(JSON.stringify(await response.json()).includes('secret'))
})

Deno.test('revocation during dependency assembly discards the entire response', async () => {
  const f = fake('<Document src="child.md" />')
  f.files.set('child.md', text('child.md'))
  let contexts = 0
  f.deps.context = () => Promise.resolve(++contexts === 1 ? { data: f.initial, error: null } : { data: null, error: { code: '42501' } })
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 404)
  assertEquals(await response.json(), { error: 'Shared file unavailable' })
})

Deno.test('changes to any project dependency while loading require a fresh read', async () => {
  const f = fake()
  let contexts = 0
  f.deps.context = () => Promise.resolve({ data: { ...f.initial, revision: ++contexts === 1 ? 3 : 4 }, error: null })
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 409)
  assertFalse('files' in await response.json())
})

Deno.test('document and import cycles stop before repeated database reads', async () => {
  for (const source of ['<Document src="note.mdx" />', `import { Again } from 'workspace:note.mdx'\n\n<Again />`]) {
    const f = fake(source)
    const response = await handleFileShare({ token: TOKEN }, f.deps)
    assertEquals(response.status, 409)
    assertEquals(readPaths(f.calls), [])
  }
})

Deno.test('a dependency shared by two branches is read only once', async () => {
  const f = fake('<Document src="a.mdx" />\n\n<Document src="b.mdx" />')
  f.files.set('a.mdx', text('a.mdx', '<Document src="common.md" />'))
  f.files.set('b.mdx', text('b.mdx', '<Document src="common.md" />'))
  f.files.set('common.md', text('common.md'))
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  assertEquals(readPaths(f.calls).filter(path => path === 'common.md').length, 1)
})

Deno.test('the graph depth is bounded before fetching the next file', async () => {
  const f = fake('<Document src="1.mdx" />')
  for (let i = 1; i <= SHARE_LIMITS.depth + 1; i++) f.files.set(`${i}.mdx`, text(`${i}.mdx`, `<Document src="${i + 1}.mdx" />`))
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 413)
  assertEquals(readPaths(f.calls).length, SHARE_LIMITS.depth)
})

Deno.test('the graph count is bounded before fetching the next file', async () => {
  const f = fake(Array.from({ length: SHARE_LIMITS.files }, (_, i) => `<Document src="${i}.md" />`).join('\n\n'))
  for (let i = 0; i < SHARE_LIMITS.files; i++) f.files.set(`${i}.md`, text(`${i}.md`))
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 413)
  assertEquals(readPaths(f.calls).length, SHARE_LIMITS.files - 1)
})

Deno.test('source byte limits refuse before parsing an oversized root', async () => {
  const f = fake('x'.repeat(SHARE_LIMITS.textBytes + 1))
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 413)
  assertEquals(readPaths(f.calls), [])
})

Deno.test('archived shares remain readable and announce their read-only comment state', async () => {
  const f = fake()
  f.initial.archived = true
  const response = await handleFileShare({ token: TOKEN }, f.deps)
  assertEquals(response.status, 200)
  assertEquals((await response.json()).share.archived, true)
})

const known = (f: ReturnType<typeof fake>) => ({id: f.initial.id, file_id: f.initial.file_id, path: f.initial.path,
  version: f.initial.version, revision: f.initial.revision, archived: f.initial.archived})

Deno.test('a progressive manifest publishes authorized text and dimensions without any Storage download', async () => {
  const f = fake('# Read now\n\n![Photo](a.png)', 'note.md')
  f.files.set('a.png', await image('a.png'))
  f.deps.download = () => {throw new Error('Storage must not gate text')}
  const response = await handleFileShare({token: TOKEN, mode: 'manifest'}, f.deps)
  assertEquals(response.status, 200)
  const result = await response.json()
  assertEquals(result.files[0].content, f.initial.content)
  assertEquals(result.pendingImages, [{path: 'a.png', width: 1, height: 1}])
  assertEquals(result.images, [])
  assertFalse(JSON.stringify(result).includes(PROJECT))
  assertEquals(f.contexts(), 2)
})

Deno.test('an unchanged refresh checks the active link without resolving dependencies or bytes', async () => {
  const f = fake('![Photo](a.png)', 'note.md')
  const response = await handleFileShare({token: TOKEN, mode: 'manifest', known: known(f)}, f.deps)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), {unchanged: true, share: known(f)})
  assertEquals(f.calls, [['context', TOKEN]])
  f.deps.context = () => Promise.resolve({data: null, error: {code: '42501'}})
  assertEquals((await handleFileShare({token: TOKEN, mode: 'manifest', known: known(f)}, f.deps)).status, 404)
})

Deno.test('a progressive image ordinal is reauthorized from the graph and bound to the manifest revision', async () => {
  const f = fake('![Photo](a.png)', 'note.md')
  f.files.set('a.png', await image('a.png'))
  f.files.set('private.png', await image('private.png'))
  f.downloads.set(`${PROJECT}/${ASSET}/original`, png)
  f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
  const response = await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 0}, f.deps)
  assertEquals(response.status, 200)
  const result = await response.json()
  assertEquals(result.image.path, 'a.png')
  assertEquals(result.image.dataURL, `data:image/png;base64,${btoa(String.fromCharCode(...png))}`)
  assertEquals(result.share, known(f))
  assertFalse(readPaths(f.calls).includes('private.png'))
  assertEquals((await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 1}, f.deps)).status, 404)
  assertEquals((await handleFileShare({token: TOKEN, mode: 'image', known: {...known(f), revision: 2}, image: 0}, f.deps)).status, 409)
  assertEquals((await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 0, path: 'private.png'}, f.deps)).status, 404)
})

Deno.test('revocation or revision changes while progressive bytes download discard those bytes', async () => {
  for (const revoke of [true, false]) {
    const f = fake('![Photo](a.png)', 'note.md')
    f.files.set('a.png', await image('a.png'))
    f.deps.download = () => {
      f.deps.context = () => Promise.resolve(revoke ? {data: null, error: {code: '42501'}} : {data: {...f.initial, revision: 4}, error: null})
      return Promise.resolve(png)
    }
    const response = await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 0}, f.deps)
    assertEquals(response.status, revoke ? 404 : 409)
    assertFalse('image' in await response.json())
  }
})

Deno.test('a failed image does not prevent the manifest or an independent image', async () => {
  const f = fake('![Bad](bad.png)\n\n![Good](good.png)', 'note.md')
  const bad = await image('bad.png'), good = await image('good.png')
  bad.asset.object_key = `${PROJECT}/${ROOT}/original`
  bad.asset.preview_key = `${PROJECT}/${ROOT}/preview`
  bad.asset.id = ROOT
  f.files.set('bad.png', bad); f.files.set('good.png', good)
  f.downloads.set(`${PROJECT}/${ASSET}/original`, png)
  f.downloads.set(`${PROJECT}/${ASSET}/preview`, png)
  assertEquals((await handleFileShare({token: TOKEN, mode: 'manifest'}, f.deps)).status, 200)
  assertEquals((await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 0}, f.deps)).status, 409)
  assertEquals((await handleFileShare({token: TOKEN, mode: 'image', known: known(f), image: 1}, f.deps)).status, 200)
})

Deno.test('progressive dependency batches stay scoped to server-parsed sibling references', async () => {
  const f = fake('<Document src="a.md" />\n\n<Document src="b.md" />')
  f.files.set('a.md', text('a.md')); f.files.set('b.md', text('b.md'))
  const batches: string[][] = []
  f.deps.readMany = (token, paths) => {
    assertEquals(token, TOKEN); batches.push(paths)
    return Promise.resolve({data: paths.map(path => f.files.get(path)).filter(Boolean), error: null})
  }
  assertEquals((await handleFileShare({token: TOKEN, mode: 'manifest'}, f.deps)).status, 200)
  assertEquals(batches, [['a.md', 'b.md']])
  assertEquals(readPaths(f.calls), [])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {resolve = done})
  return {promise, resolve}
}
async function lines(response: Response) {
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line))
}

Deno.test('a stream publishes the complete root before a delayed child source and Storage bytes', async () => {
  const f = fake('# Read now\n\n<Document src="slow.md" />\n\n![Photo](a.png)')
  const child = deferred<{data: FileRecord; error: null}>()
  const storage = deferred<Uint8Array>()
  f.files.set('a.png', await image('a.png'))
  const originalRead = f.deps.read
  f.deps.read = (token, path) => path === 'slow.md' ? child.promise : originalRead(token, path)
  f.deps.download = () => storage.promise
  const response = await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps)
  assertEquals(response.headers.get('content-type'), 'application/x-ndjson')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let root = ''
  while (!root.includes('"type":"file"')) root += decoder.decode((await reader.read()).value)
  assert(root.includes('# Read now'))
  assertFalse(root.includes('"type":"complete"'))
  child.resolve({data: text('slow.md', '# Child'), error: null})
  storage.resolve(png)
  let rest = ''
  while (true) {const result = await reader.read(); if (result.done) break; rest += decoder.decode(result.value)}
  reader.releaseLock()
  assert(rest.includes('# Child'))
  assert(rest.includes('"type":"image"'))
  assert(rest.includes('"type":"complete"'))
})

Deno.test('a missing child and failed image are local stream placeholders beside ready text', async () => {
  const f = fake('# Root\n\n<Document src="missing.md" />\n\n![Photo](a.png)')
  f.files.set('a.png', await image('a.png'))
  const events = await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps))
  assert(events.some(event => event.type === 'file' && event.file.content.startsWith('# Root')))
  assert(events.some(event => event.type === 'file-error' && event.path === 'missing.md'))
  assert(events.some(event => event.type === 'image-error' && event.path === 'a.png'))
  assertEquals(events.at(-1), {type: 'complete'})
  assertFalse(events.some(event => event.type === 'error'))
})

Deno.test('a stream revalidates revocation and revisions before later publication', async () => {
  for (const revoke of [true, false]) {
    const f = fake('# Root\n\n![Photo](a.png)')
    f.files.set('a.png', await image('a.png'))
    f.deps.download = () => {
      f.deps.context = () => Promise.resolve(revoke ? {data: null, error: {code: '42501'}} : {data: {...f.initial, revision: 4}, error: null})
      return Promise.resolve(png)
    }
    const events = await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps))
    assert(events.some(event => event.type === 'file' && event.file.path === 'note.mdx'))
    assertEquals(events.at(-1).status, revoke ? 404 : 409)
    assertFalse(events.some(event => event.type === 'image'))
    assertFalse(events.some(event => event.type === 'complete'))
  }
})

Deno.test('canceling a progressive reader stops queued dependency reads', async () => {
  const f = fake(Array.from({length: 20}, (_, index) => `<Document src="${index}.md" />`).join('\n\n'))
  const blocked = deferred<{data: null; error: null}>()
  f.deps.read = (_token, path) => {f.calls.push(['read', path]); return blocked.promise}
  const response = await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps)
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  blocked.resolve({data: null, error: null})
  await new Promise(resolve => setTimeout(resolve, 0))
  assert(readPaths(f.calls).length <= 4)
})

Deno.test('stream aggregate text/depth bounds invalidate partial availability', async () => {
  const f = fake('<Document src="child.md" />')
  f.files.set('child.md', text('child.md', 'x'.repeat(SHARE_LIMITS.textBytes)))
  const events = await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps))
  assertEquals(events.at(-1).type, 'error')
  assertEquals(events.at(-1).status, 413)
  assertFalse(events.some(event => event.type === 'complete'))
})

Deno.test('stream discovery bounds missing paths before publishing the root or starting RPCs', async () => {
  const f = fake(Array.from({length: SHARE_LIMITS.files * 4}, (_, index) => `<Document src="missing-${index}.md" />`).join('\n\n'))
  const events = await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps))
  assertEquals(events.at(-1).type, 'error')
  assertEquals(events.at(-1).status, 413)
  assertFalse(events.some(event => event.type === 'file'))
  assertEquals(readPaths(f.calls), [])
})

Deno.test('stream discovery counts missing optional companions and deduplicates shared dependency reads', async () => {
  const f = fake(Array.from({length: 50}, (_, index) => `<Diagram src="flow-${index}.d2" />`).join('\n\n'))
  for (let index = 0; index < 50; index++) f.files.set(`flow-${index}.d2`, text(`flow-${index}.d2`, 'a -> b'))
  const events = await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, f.deps))
  assertEquals(events.at(-1).status, 413)
  const paths = readPaths(f.calls)
  assert(paths.length <= SHARE_LIMITS.files - 1)
  assertEquals(new Set(paths).size, paths.length)
  const duplicate = fake('<Document src="a.mdx" />\n\n<Document src="b.mdx" />')
  duplicate.files.set('a.mdx', text('a.mdx', '<Document src="common.md" />'))
  duplicate.files.set('b.mdx', text('b.mdx', '<Document src="common.md" />'))
  duplicate.files.set('common.md', text('common.md'))
  assertEquals((await lines(await handleFileShare({token: TOKEN, mode: 'manifest', stream: true}, duplicate.deps))).at(-1).type, 'complete')
  assertEquals(readPaths(duplicate.calls).filter(path => path === 'common.md').length, 1)
})
