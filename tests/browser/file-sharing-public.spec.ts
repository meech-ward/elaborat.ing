import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {strFromU8, unzipSync} from 'fflate'
import {DOMParser} from '@xmldom/xmldom'
import AxeBuilder from './axe.ts'
import { expect, test, type Locator, type Page, type Route } from './fixtures.ts'
import { fakeSupabase, person, signedIn, SUPABASE } from './fake-supabase.ts'
import { APP_URL } from './urls.ts'
import type { RemoteThread } from '../../src/features/comments/remote.ts'
import type { CommentAnchor } from '../../src/features/comments/placement.ts'
import type { SharedBundle } from '../../src/features/file-sharing/publicRemote.ts'
import { inspectImage } from '../../src/features/images/format.ts'

test.describe.configure({ timeout: 60_000 })
const TOKEN = 'ab'.repeat(32)
const SHARE = 'a0000000-0000-4000-8000-000000000001'
const FILE = 'f0000000-0000-4000-8000-000000000001'
const href = new URL(`s/${TOKEN}`, APP_URL).href
const FRAME = 'iframe[title="Isolated document preview"]'
const frame = (page: Page) => page.frameLocator(FRAME).first()
const panel = (page: Page) => page.getByRole('complementary', {name: 'Shared file comments'})
  .or(page.getByRole('dialog', {name: 'Shared file comments'}))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6kAAAAASUVORK5CYII='
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS'}
const now = () => new Date().toISOString()
const author = () => ({user_id: person.id, email: null, name: 'Visitor'})
const EXPORT_DRAWING = JSON.stringify({type: 'excalidraw', version: 2, appState: {}, files: {}, elements: [{
  id: 'export-box', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
}]})

async function sharedExportDialog(page: Page, format: 'Notion' | 'Google Docs' = 'Notion') {
  await page.getByRole('button', {name: 'Export', exact: true}).click()
  await page.getByRole('menuitem', {name: `Export to ${format}`, exact: true}).click()
  const dialog = page.getByRole('dialog', {name: `Export to ${format}`, exact: true})
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/saved/i)
  await expect(dialog).not.toContainText(/unsaved/i)
  return dialog
}

async function downloadNotion(page: Page, dialog: Locator) {
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toBeVisible({timeout: 45_000})
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).click()
  const download = await pending
  const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)))
  expect(download.suggestedFilename()).toMatch(/-notion\.zip$/)
  const pages = Object.keys(entries).filter(path => path.endsWith('.html'))
  expect(pages).toHaveLength(1)
  expect(Object.keys(entries).every(path => path === pages[0] || /^assets\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(path))).toBe(true)
  return {entries, html: strFromU8(entries[pages[0]])}
}

async function downloadGoogleDocs(page: Page, dialog: Locator) {
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toBeVisible({timeout: 45_000})
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', {name: 'Download DOCX', exact: true}).click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.docx$/)
  const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)))
  expect(strFromU8(entries['[Content_Types].xml'])).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
  const xml = strFromU8(entries['word/document.xml'])
  const parsed = new DOMParser().parseFromString(xml, 'text/xml')
  const text = Array.from(parsed.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')).map(node => node.textContent).join('')
  expect(xml).not.toContain('altChunk')
  const media = Object.keys(entries).filter(path => path.startsWith('word/media/'))
  const relationBytes = entries['word/_rels/document.xml.rels']
  if (media.length) expect(relationBytes).toBeDefined()
  const relationships = relationBytes ? new DOMParser().parseFromString(strFromU8(relationBytes), 'text/xml') : null
  for (const relationship of Array.from(relationships?.getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship') ?? [])) {
    if (!relationship.getAttribute('Type')?.endsWith('/image')) continue
    expect(relationship.getAttribute('TargetMode')).not.toBe('External')
    const target = relationship.getAttribute('Target')!
    expect(target).not.toMatch(/^(?:https?:|data:|blob:)/)
    expect(entries[new URL(target, 'https://docx.invalid/word/document.xml').pathname.slice(1)]).toBeDefined()
  }
  return {entries, xml, text, media}
}

async function expectNoCodePrompt(page: Page) {
  for (const surface of page.frames()) {
    await expect(surface.getByRole('heading', {name: 'This file runs custom code', exact: true})).toHaveCount(0)
    await expect(surface.getByRole('button', {name: /^Run (code|document)$/})).toHaveCount(0)
    await expect(surface.getByText('This document contains code. Review it separately or run it here.', {exact: true})).toHaveCount(0)
  }
}

function bundle(content = '# Shared guide\n\nRead without an account.', path = 'guide.mdx'): SharedBundle {
  return {share: {id: SHARE, file_id: FILE, path, version: 7, revision: 7, archived: false},
    files: [{id: FILE, path, content, version: 7}], images: []}
}

function discussionThreads(count: number): RemoteThread[] {
  return Array.from({length: count}, (_, index) => ({
    id: crypto.randomUUID(), file_id: FILE, path: 'guide.mdx', file_deleted: false, file_version: 7,
    anchor: {kind: 'document'}, created_at: now(), resolved_at: null, resolved_by: null, ask_agent: false,
    comments: [{id: crypto.randomUUID(), author: author(), via_agent: false, agent: null,
      body: `Review ${index + 1}: ${'Keep this part clear. '.repeat(6).trim()}`,
      created_at: now(), edited_at: null, deleted_at: null, file_version: null}],
  }))
}

async function setup(page: Page, options: {bundle?: SharedBundle; signedIn?: boolean; threads?: RemoteThread[]} = {}) {
  const fake = await fakeSupabase(page)
  if (options.signedIn) await signedIn(page)
  const state = {bundle: options.bundle ?? bundle(), threads: options.threads ?? [] as RemoteThread[], revoked: false,
    calls: [] as {name: string; args: Record<string, unknown>}[]}
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({status, headers: CORS, contentType: 'application/json', body: JSON.stringify(value)})
  await page.route(`${SUPABASE}/functions/v1/file-share`, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS})
    state.calls.push({name: 'read', args: route.request().postDataJSON() as Record<string, unknown>})
    return state.revoked ? json(route, {error: 'Shared file unavailable'}, 404) : json(route, state.bundle)
  })
  await page.route(`${SUPABASE}/rest/v1/rpc/*file_share*`, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS})
    const name = new URL(route.request().url()).pathname.split('/').pop()!
    const args = route.request().postDataJSON() as Record<string, unknown>
    state.calls.push({name, args})
    if (state.revoked) return json(route, {code: '42501', message: 'Shared file unavailable'}, 403)
    if (name === 'list_file_share_comments') return json(route, {share_id: SHARE, file_id: FILE,
      file_version: state.bundle.share.version, archived: state.bundle.share.archived, can_moderate: false, threads: state.threads})
    const makeComment = () => ({id: String(args.comment_id), author: author(), via_agent: false, agent: null,
      body: String(args.body), created_at: now(), edited_at: null, deleted_at: null, file_version: null})
    if (name === 'add_file_share_comment') {
      const existing = state.threads.find(thread => thread.id === args.thread_id)
      if (existing) return json(route, {thread: existing})
      const thread: RemoteThread = {id: String(args.thread_id), file_id: FILE, path: state.bundle.share.path,
        file_deleted: false, file_version: Number(args.file_version), anchor: args.anchor as CommentAnchor,
        created_at: now(), resolved_at: null, resolved_by: null, ask_agent: false, comments: [makeComment()]}
      state.threads.push(thread)
      return json(route, {thread})
    }
    const thread = state.threads.find(t => t.id === args.thread_id || t.comments.some(c => c.id === args.comment_id))
    if (!thread) return json(route, {code: '42501', message: 'Comment unavailable'}, 403)
    if (name === 'reply_file_share_comment') {const comment = makeComment(); thread.comments.push(comment); return json(route, {comment})}
    if (name === 'resolve_file_share_thread') {thread.resolved_at = args.resolved ? now() : null; thread.resolved_by = args.resolved ? author() : null; return json(route, {thread})}
    const comment = thread.comments.find(c => c.id === args.comment_id)!
    if (name === 'edit_file_share_comment') {comment.body = String(args.body); comment.edited_at = now(); return json(route, {comment})}
    if (name === 'delete_file_share_comment') {comment.body = null; comment.deleted_at = now(); return json(route, {comment})}
    return json(route, {error: `Unexpected RPC ${name}`}, 400)
  })
  return {state, fake}
}

test('anyone can read a complete long rendered file without project or source controls', async ({page}) => {
  const content = `# Shared guide\n\n${'A paragraph in the full shared document.\n\n'.repeat(650)}## End of the full file\n\nNothing was truncated.`
  const {state, fake} = await setup(page, {bundle: bundle(content, 'long.md')})
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await expect(frame(page).getByRole('heading', {name: 'End of the full file'})).toBeAttached()
  await expect(frame(page).getByText('Nothing was truncated.')).toBeAttached()
  await expect(page).toHaveURL(href)
  await expect(page.getByRole('button', {name: 'Source', exact: true})).toHaveCount(0)
  await expect(page.getByRole('navigation', {name: 'Workspace files'})).toHaveCount(0)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  expect(state.calls.find(c => c.name === 'read')?.args).toEqual({token: TOKEN, mode: 'manifest', stream: true})
  expect(fake.requests.some(r => /project_files|list_projects|list_members|list_comments/.test(r.url()))).toBe(false)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow, noarchive')
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
})

test('anonymous visitors export Notion and Google Docs with editable text, original assets and current components from the authorized share only', async ({page}) => {
  test.setTimeout(90_000)
  const pictures = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'; context.fillRect(0, 0, 1600, 900)
    context.fillStyle = 'black'
    for (let x = 0; x < 1600; x += 4) context.fillRect(x, 0, 1, 900)
    const preview = document.createElement('canvas')
    preview.width = 480; preview.height = 270
    preview.getContext('2d')!.drawImage(canvas, 0, 0, 480, 270)
    return {original: canvas.toDataURL('image/png'), preview: preview.toDataURL('image/png')}
  })
  const source = `import {useState} from 'react'

export function PublicExportCounter() {
  const [count, setCount] = useState(0)
  return <section><h2>Live shared component</h2><p>Visible count: {count}</p><button type="button" onClick={() => setCount(count + 1)}>Increase public counter</button><form><label>Private input<input aria-label="Private input" defaultValue="private-default-value" /></label><input aria-label="Private password" type="password" defaultValue="password-export-secret" /><button type="button">Keep this label</button></form></section>
}

# Shared export

An **editable** paragraph.

\`\`\`cpp
int main() { return 0; }
\`\`\`

<PublicExportCounter />

![Detailed shared screenshot](images/detail.png)

<Drawing src="art/board.excalidraw" />

<Diagram src="art/flow.d2" />

<Document src="notes/live.mdx" title="Live export detail" defaultCollapsed />

<Document src="notes/child.mdx" title="Unopened export detail" defaultCollapsed />

[Private planning](private/plan.md)

![Remote illustration](https://public-export-probe.example/image.png)`
  const shared = bundle(source)
  const saved = JSON.parse(readFileSync(join(import.meta.dirname, 'chat-card-diagram.json'), 'utf8')) as {source: string; canvas: string; layout: string}
  const files = {
    'images/detail.png': '',
    'art/board.excalidraw': EXPORT_DRAWING,
    'art/flow.d2': saved.source,
    'art/flow.excalidraw': saved.canvas,
    'art/flow.d2.json': saved.layout,
    'notes/live.mdx': "import {useState} from 'react'\n\nexport function ChildExportCounter() {const [count, setCount] = useState(0); return <section><p>Child visible count: {count}</p><button type=\"button\" onClick={() => setCount(count + 1)}>Increase child counter</button></section>}\n\n# Live child detail\n\n<ChildExportCounter />",
    'notes/child.mdx': 'import {ExportDetail} from "workspace:components/export-detail.mdx"\n\n# Child export detail\n\nA child that was never expanded.\n\n<ExportDetail />',
    'components/export-detail.mdx': 'export const ExportDetail = () => <strong>Fresh child component content.</strong>',
  }
  shared.files.push(...Object.entries(files).map(([path, content]) => ({id: crypto.randomUUID(), path, content, version: 7})))
  shared.images.push({path: 'images/detail.png', dataURL: pictures.original, width: 1600, height: 900,
    preview: {dataURL: pictures.preview, width: 480, height: 270}})
  const reached: string[] = []
  await page.route('https://public-export-probe.example/**', route => {reached.push(route.request().url()); return route.fulfill({body: 'Unexpected external request'})})
  const {state, fake} = await setup(page, {bundle: shared})
  const privateId = crypto.randomUUID()
  const remote = fake.server.remote(person.id)
  await remote.createProject(privateId, 'Unshared project')
  await remote.saveFiles(privateId, crypto.randomUUID(), [{op: 'put', path: 'private/plan.md', content: 'UNSHARED_PRIVATE_CONTENT_MUST_NOT_LEAVE'}])
  await page.goto(href)
  await expect(frame(page).getByRole('button', {name: 'Increase public counter', exact: true})).toBeVisible({timeout: 20_000})
  await expectNoCodePrompt(page)
  await frame(page).getByRole('button', {name: 'Increase public counter', exact: true}).click()
  await frame(page).getByRole('button', {name: 'Increase public counter', exact: true}).click()
  await expect(frame(page).getByText('Visible count: 2', {exact: true})).toBeVisible()
  await frame(page).getByLabel('Private input', {exact: true}).fill('private-live-value')
  const child = frame(page).locator('[data-document-embed="notes/child.mdx"]')
  await expect(child.locator('iframe')).toHaveCount(0)
  const live = frame(page).locator('[data-document-embed="notes/live.mdx"]')
  await live.getByRole('button', {name: 'Live export detail', exact: true}).click()
  const childPreview = live.frameLocator('iframe')
  await childPreview.getByRole('button', {name: 'Increase child counter', exact: true}).click()
  await expect(childPreview.getByText('Child visible count: 1', {exact: true})).toBeVisible()
  const requestStart = fake.requests.length
  const dialog = await sharedExportDialog(page)
  await dialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  const {entries, html} = await downloadNotion(page, dialog)
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toHaveText('Ready: 3 documents and 3 images.')
  expect(html).toContain('<h1>Shared export</h1>')
  expect(html).toContain('<strong>editable</strong>')
  expect(html).toContain('<pre><code class="language-cpp">int main() { return 0; }')
  expect(html).toContain('Visible count: 2')
  expect(html).toContain('Child visible count: 1')
  expect(html).toContain('A child that was never expanded.')
  expect(html).toContain('Fresh child component content.')
  expect(html).toContain('Keep this label')
  expect(html).toContain('Remote illustration unavailable')
  expect(html).not.toMatch(/UNSHARED_PRIVATE_CONTENT|private-default-value|private-live-value|password-export-secret|<form|<input|<button|<script|<iframe|contenteditable|data:|https:\/\/public-export-probe|\/projects\//)
  const refs = [...html.matchAll(/<img src="([^"]+)"/g)].map(match => match[1])
  expect(refs).toHaveLength(3)
  expect(Buffer.from(entries[refs[0]]).equals(Buffer.from(pictures.original.split(',')[1], 'base64'))).toBe(true)
  expect(inspectImage(entries[refs[0]])).toMatchObject({width: 1600, height: 900})
  for (const path of refs.slice(1)) {
    const image = inspectImage(entries[path], 'image/png')
    expect(image.width * image.height).toBeLessThanOrEqual(8_000_000)
    expect(entries[path].length).toBeLessThanOrEqual(5 * 1024 * 1024)
  }
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  const googleDialog = await sharedExportDialog(page, 'Google Docs')
  await googleDialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  const docx = await downloadGoogleDocs(page, googleDialog)
  await expect(googleDialog.getByRole('status').filter({hasText: /^Ready:/})).toHaveText('Ready: 3 documents and 3 images.')
  for (const text of ['Shared export', 'An editable paragraph.', 'Visible count: 2', 'Child visible count: 1', 'A child that was never expanded.', 'Fresh child component content.', 'Keep this label'])
    expect(docx.text).toContain(text)
  expect(docx.media).toHaveLength(3)
  const original = Buffer.from(pictures.original.split(',')[1], 'base64')
  expect(docx.media.some(path => Buffer.from(docx.entries[path]).equals(original))).toBe(true)
  const documentXml = Object.entries(docx.entries).filter(([path]) => /\.(?:xml|rels)$/.test(path)).map(([, bytes]) => strFromU8(bytes)).join('\n')
  expect(documentXml).not.toMatch(/UNSHARED_PRIVATE_CONTENT|private-default-value|private-live-value|password-export-secret|<form|<input|<script|<iframe|https:\/\/public-export-probe|\/projects\//)
  await googleDialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  await expect(child.locator('iframe')).toHaveCount(0)
  await expect(childPreview.getByText('Child visible count: 1', {exact: true})).toBeVisible()
  await expect(frame(page).getByText('Visible count: 2', {exact: true})).toBeVisible()
  await expect(page).toHaveURL(href)
  expect(reached).toEqual([])
  expect(fake.requests.slice(requestStart).some(request => /\/auth\/v1|\/storage\/v1|project_files|list_projects|list_members|save_files|save_file/.test(request.url()))).toBe(false)
  expect(state.calls.every(call => call.name === 'read' || call.name === 'list_file_share_comments')).toBe(true)
  expect(state.calls.filter(call => call.name === 'read').every(call => call.args.token === TOKEN && call.args.mode === 'manifest' && !('path' in call.args))).toBe(true)
  expect(fake.server.content(privateId, 'private/plan.md')).toBe('UNSHARED_PRIVATE_CONTENT_MUST_NOT_LEAVE')
  expect(state.bundle.files[0].content).toBe(source)
})

for (const format of ['Notion', 'Google Docs'] as const) for (const change of ['revision', 'revocation'] as const) test(`a known share ${change} cancels an in-progress ${format} export and never restores its stale download`, async ({page, appErrors}) => {
  if (change === 'revocation') appErrors.expect('This link is unavailable.')
  const shared = bundle('# Original shared version\n\n<Drawing src="board.excalidraw" />')
  shared.files.push({id: crypto.randomUUID(), path: 'board.excalidraw', content: EXPORT_DRAWING, version: 7})
  const {state} = await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(frame(page).locator('figure[data-src="board.excalidraw"]')).toHaveAttribute('data-pixels', 'true', {timeout: 45_000})
  let downloads = 0
  page.on('download', () => {downloads++})
  const dialog = await sharedExportDialog(page, format)
  // Hold the native PNG callback, rather than relying on conversion taking
  // long enough for the share refresh to win a timing race.
  await page.evaluate(() => {
    type Gate = {held: number; completed: number; release: () => void}
    const gate: Gate = {held: 0, completed: 0, release: () => {}}
    const original = HTMLCanvasElement.prototype.toBlob
    const pending: Array<() => void> = []
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      gate.held++
      pending.push(() => original.call(this, blob => {gate.completed++; callback(blob)}, type, quality))
    }
    gate.release = () => {HTMLCanvasElement.prototype.toBlob = original; for (const resume of pending.splice(0)) resume()}
    ;(window as unknown as {exportRasterGate: Gate}).exportRasterGate = gate
  })
  await dialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as {exportRasterGate: {held: number}}).exportRasterGate.held), {timeout: 30_000}).toBeGreaterThan(0)
  await expect(dialog.getByRole('button', {name: 'Preparing…', exact: true})).toBeDisabled()
  if (change === 'revocation') state.revoked = true
  else {
    state.bundle = bundle('# Updated shared version\n\nThe latest saved content.')
    state.bundle.share.version = 8; state.bundle.share.revision = 8
    state.bundle.files[0].version = 8
  }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(dialog).toHaveCount(0)
  if (change === 'revocation') await expect(page.getByRole('heading', {name: 'Shared file unavailable', exact: true})).toBeVisible()
  else await expect(frame(page).getByRole('heading', {name: 'Updated shared version', exact: true})).toBeVisible()
  await page.evaluate(() => (window as unknown as {exportRasterGate: {release: () => void}}).exportRasterGate.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as {exportRasterGate: {completed: number}}).exportRasterGate.completed)).toBeGreaterThan(0)
  await expect(page.getByRole('button', {name: 'Download ZIP', exact: true})).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Download DOCX', exact: true})).toHaveCount(0)
  expect(downloads).toBe(0)
  if (change === 'revocation') await expect(page.getByRole('button', {name: 'Export', exact: true})).toHaveCount(0)
  else {
    const current = await sharedExportDialog(page, format)
    await current.getByRole('button', {name: 'Prepare export', exact: true}).click()
    const output = format === 'Notion' ? (await downloadNotion(page, current)).html : (await downloadGoogleDocs(page, current)).text
    expect(output).toContain('The latest saved content.')
    expect(output).not.toContain('Original shared version')
    expect(downloads).toBe(1)
  }
})

test('anonymous phone readers can discover, cancel and download accessible export formats without signing in', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844})
  const {state, fake} = await setup(page, {bundle: bundle('# Phone export\n\nA **portable** saved paragraph.', 'phone.md')})
  await page.goto(href)
  const exportButton = page.getByRole('button', {name: 'Export', exact: true})
  await expect(exportButton).toBeVisible()
  const controls = (await page.getByRole('group', {name: 'Shared file controls'}).boundingBox())!
  expect(controls.x).toBeGreaterThanOrEqual(0)
  expect(controls.x + controls.width).toBeLessThanOrEqual(390)
  expect(controls.y + controls.height).toBeLessThanOrEqual(844)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  let downloads = 0
  page.on('download', () => {downloads++})
  await exportButton.click()
  const menu = page.getByRole('menu')
  await expect(page.getByRole('menuitem', {name: 'Export to Notion', exact: true})).toBeVisible()
  await expect(page.getByRole('menuitem', {name: 'Export to Google Docs', exact: true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  const canceled = await sharedExportDialog(page)
  await expect(canceled).toHaveCSS('opacity', '1')
  const accessibility = await new AxeBuilder({page}).include('[role="dialog"]').analyze()
  expect(accessibility.violations.map(violation => ({id: violation.id, targets: violation.nodes.map(node => node.target)}))).toEqual([])
  await canceled.getByRole('button', {name: 'Cancel', exact: true}).click()
  await expect(canceled).toHaveCount(0)
  expect(downloads).toBe(0)
  const dialog = await sharedExportDialog(page)
  await dialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  const {entries, html} = await downloadNotion(page, dialog)
  expect(Object.keys(entries)).toEqual(['phone.html'])
  expect(html).toContain('<strong>portable</strong>')
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  const googleDialog = await sharedExportDialog(page, 'Google Docs')
  await expect(googleDialog).toHaveCSS('opacity', '1')
  const googleAccessibility = await new AxeBuilder({page}).include('[role="dialog"]').analyze()
  expect(googleAccessibility.violations.map(violation => ({id: violation.id, targets: violation.nodes.map(node => node.target)}))).toEqual([])
  await googleDialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  expect((await downloadGoogleDocs(page, googleDialog)).text).toContain('A portable saved paragraph.')
  expect(state.bundle.files[0].content).toBe('# Phone export\n\nA **portable** saved paragraph.')
  expect(fake.requests.some(request => /\/auth\/v1|save_files|share_project|accept_invitation/.test(request.url()))).toBe(false)
  await expect(page).toHaveURL(href)
})

test('shared notes render local images, drawings, diagrams, and collapsible embedded documents', async ({page}) => {
  const shared = bundle('# Shared guide\n\n![Shared pixel](photo.png)\n\n<Drawing src="board.excalidraw" />\n\n<Diagram src="flow.d2" />\n\n<Document src="child.md" title="Implementation details" defaultCollapsed />')
  shared.files.push({id: crypto.randomUUID(), path: 'child.md', content: '# Embedded details\n\nThis child remains a separate file.', version: 7},
    {id: crypto.randomUUID(), path: 'board.excalidraw', content: JSON.stringify({type: 'excalidraw', version: 2, elements: [
      {id: 'box', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
        roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false},
    ], appState: {}, files: {}}), version: 7},
    {id: crypto.randomUUID(), path: 'flow.d2', content: 'a -> b: Shared diagram\n', version: 7})
  shared.images.push({path: 'photo.png', dataURL: PNG, width: 1, height: 1, preview: {dataURL: PNG, width: 1, height: 1}})
  await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(frame(page).getByRole('img', {name: 'Shared pixel'})).toBeVisible({timeout: 20_000})
  await expect(frame(page).locator('figure[data-src="board.excalidraw"]')).toHaveAttribute('data-pixels', 'true', {timeout: 45_000})
  await expect(frame(page).locator('figure[data-src="flow.d2"]')).toHaveAttribute('data-pixels', 'true', {timeout: 45_000})
  await expect(frame(page).getByRole('button', {name: /^Edit (drawing|diagram)$/})).toHaveCount(0)
  await frame(page).getByRole('button', {name: 'View drawing board.excalidraw', exact: true}).click()
  const drawing = page.getByRole('dialog', {name: 'Drawing: board.excalidraw', exact: true})
  await expect(drawing).toBeVisible()
  await drawing.getByRole('button', {name: 'Close', exact: true}).click()
  await frame(page).getByRole('button', {name: 'View diagram flow.d2', exact: true}).click()
  const diagram = page.getByRole('dialog', {name: 'Diagram: flow.d2', exact: true})
  await expect(diagram).toBeVisible()
  await diagram.getByRole('button', {name: 'Close', exact: true}).click()
  const details = frame(page).getByRole('button', {name: /Implementation details/}).first()
  await details.click()
  await expect(page.locator(FRAME)).toHaveCount(1)
  await expect.poll(async () => (await Promise.all(page.frames().map(f => f.getByRole('heading', {name: 'Embedded details'}).count()))).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
})

test('embedded shared images retain original detail and vector or animated originals stay static', async ({page}) => {
  const raster = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#111'
    for (let y = 0; y < canvas.height; y += 8) for (let x = 0; x < canvas.width; x += 8)
      if ((x / 8 + y / 8) % 2) context.fillRect(x, y, 8, 8)
    const original = canvas.toDataURL('image/png')
    const preview = document.createElement('canvas')
    preview.width = 480; preview.height = 270
    preview.getContext('2d')!.drawImage(canvas, 0, 0, preview.width, preview.height)
    return {original, preview: preview.toDataURL('image/png')}
  })
  const shared = bundle('# Shared guide\n\n![Detailed screenshot](screenshot.png)\n\n![Vector detail](vector.svg)\n\n![Paused animation](animated.gif)\n\n<Document src="details.mdx" title="More screenshots" defaultCollapsed />')
  shared.files.push({id: crypto.randomUUID(), path: 'details.mdx', version: 7,
    content: 'import {Screenshot} from "workspace:components/screenshot.mdx"\n\n# Screenshot details\n\n<Screenshot />'},
  {id: crypto.randomUUID(), path: 'components/screenshot.mdx', version: 7,
    content: 'export const Screenshot = () => <img src="../screenshot.png" alt="Component screenshot" />'})
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><path d="M0 1H1600M1 0V900M800 0V900" stroke="black" stroke-width="1"/></svg>'
  shared.images.push(
    {path: 'screenshot.png', dataURL: raster.original, width: 1600, height: 900, preview: {dataURL: raster.preview, width: 480, height: 270}},
    {path: 'vector.svg', dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: 1600, height: 900, preview: {dataURL: raster.preview, width: 480, height: 270}},
    {path: 'animated.gif', dataURL: 'data:image/gif;base64,R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7', width: 2, height: 2, preview: {dataURL: PNG, width: 1, height: 1}},
  )
  const {fake} = await setup(page, {bundle: shared})
  await page.goto(href)
  const examples = [{name: 'Detailed screenshot', width: 1600, height: 900}, {name: 'Vector detail', width: 1600, height: 900}, {name: 'Paused animation', width: 2, height: 2}]
  const expectDetail = async () => {
    for (const example of examples) {
      const inline = frame(page).getByRole('button', {name: `View image: ${example.name}`, exact: true}).locator('img')
      await inline.scrollIntoViewIfNeeded()
      await expect.poll(() => inline.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(example.width)
      await expect.poll(() => inline.evaluate(element => (element as HTMLImageElement).naturalHeight)).toBe(example.height)
      const source = (await inline.getAttribute('src'))!
      if (example.name === 'Detailed screenshot') expect(source).toBe(raster.original)
      else {
        expect(source).toMatch(/^data:image\/(png|webp);base64,/)
        expect(inspectImage(Buffer.from(source.split(',')[1], 'base64')).animated).toBe(false)
      }
    }
  }
  const expectNestedDetail = async () => {
    await frame(page).getByRole('button', {name: /More screenshots/}).first().click()
    await expect.poll(async () => (await Promise.all(page.frames().map(surface =>
      surface.getByRole('heading', {name: 'Screenshot details', exact: true}).count()))).reduce((sum, count) => sum + count, 0)).toBe(1)
    const surfaces = await Promise.all(page.frames().map(async surface =>
      await surface.getByRole('heading', {name: 'Screenshot details', exact: true}).count() ? surface : null))
    const nested = surfaces.find(surface => surface !== null)!.getByRole('button', {name: 'View image: Component screenshot', exact: true}).locator('img')
    await nested.scrollIntoViewIfNeeded()
    await expect(nested).toHaveAttribute('src', raster.original)
    await expect.poll(() => nested.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1600)
    await expectNoCodePrompt(page)
  }
  await expectDetail()
  await expectNestedDetail()
  await frame(page).getByRole('button', {name: 'View image: Detailed screenshot', exact: true}).click()
  const viewer = frame(page).getByRole('dialog', {name: 'Detailed screenshot', exact: true})
  await expect.poll(() => viewer.getByRole('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1600)
  await viewer.getByRole('button', {name: 'Close image', exact: true}).click()
  await expect(viewer).toBeHidden()
  await expectDetail()
  await page.reload()
  await expectDetail()
  await expectNestedDetail()
  expect(fake.requests.some(request => /storage\/v1|project_files/.test(request.url()))).toBe(false)
})

test('an embedded document opened separately fits a short landscape viewport', async ({page}) => {
  await page.setViewportSize({width: 844, height: 390})
  const shared = bundle('# Shared guide\n\n<Document src="child.md" title="Landscape details" />')
  shared.files.push({id: crypto.randomUUID(), path: 'child.md', version: 7,
    content: `# Embedded landscape details\n\n${'Read a paragraph in the embedded file.\n\n'.repeat(20)}The landscape document ends here.`})
  await setup(page, {bundle: shared})
  await page.goto(href)
  await frame(page).getByRole('button', {name: 'Open separately', exact: true}).click()
  const dialog = page.getByRole('dialog', {name: 'child.md', exact: true})
  await expect(dialog).toBeVisible()
  const preview = dialog.locator(FRAME)
  await expect(dialog.frameLocator(FRAME).getByRole('heading', {name: 'Embedded landscape details'})).toBeVisible()
  const box = (await dialog.boundingBox())!
  const previewBox = (await preview.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(391)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(845)
  expect(previewBox.y).toBeGreaterThanOrEqual(box.y)
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(box.y + box.height + 1)
  const close = dialog.getByRole('button', {name: 'Close', exact: true})
  await expect(close).toBeInViewport()
  await close.click()
  await expect(dialog).toHaveCount(0)
})

test('ordinary project links stay private while shared custom components render automatically', async ({page}) => {
  const shared = bundle('export const PublicBadge = () => <span>Custom shared badge</span>\n\n# Shared guide\n\n<PublicBadge />\n\n[Private planning](secret.md)')
  const {state} = await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(frame(page).getByText('Custom shared badge')).toBeVisible({timeout: 20_000})
  await expectNoCodePrompt(page)
  await frame(page).getByRole('link', {name: 'Private planning'}).click()
  await expect(page.getByText('That link points to another project file. It needs its own share link.')).toBeVisible()
  await expect(page).toHaveURL(href)
  expect(state.calls.filter(c => c.name === 'read').every(c => c.args.token === TOKEN && c.args.mode === 'manifest' && !('path' in c.args))).toBe(true)
})

test('nested shared documents run components automatically while keeping their sandbox isolation', async ({page}) => {
  const shared = bundle('# Shared guide\n\n<Document src="nested/child.mdx" title="Interactive details" defaultCollapsed />')
  shared.files.push({id: crypto.randomUUID(), path: 'nested/child.mdx', version: 7,
    content: 'import {NestedCounter} from "workspace:components/nested-counter.mdx"\n\n# Nested interactive details\n\n<NestedCounter />'},
  {id: crypto.randomUUID(), path: 'components/nested-counter.mdx', version: 7,
    content: "import {useState} from 'react'\n\nexport function NestedCounter() { const [count, setCount] = useState(0); return <button type=\"button\" onClick={() => setCount(count + 1)}>Nested count: {count}</button> }"})
  const reached: string[] = []
  await page.route('https://nested-component-probe.example/**', route => {
    reached.push(route.request().url())
    return route.fulfill({status: 200, body: 'Unexpected network access'})
  })
  const {state, fake} = await setup(page, {bundle: shared})
  const original = state.bundle.files.map(file => file.content)
  await page.goto(href)
  await frame(page).getByRole('button', {name: /Interactive details/}).first().click()
  await expect.poll(async () => (await Promise.all(page.frames().map(surface =>
    surface.getByRole('heading', {name: 'Nested interactive details', exact: true}).count()))).reduce((sum, count) => sum + count, 0)).toBe(1)
  const surfaces = await Promise.all(page.frames().map(async surface =>
    await surface.getByRole('heading', {name: 'Nested interactive details', exact: true}).count() ? surface : null))
  const child = surfaces.find(surface => surface !== null)!
  await child.getByRole('button', {name: 'Nested count: 0', exact: true}).click()
  await expect(child.getByRole('button', {name: 'Nested count: 1', exact: true})).toBeVisible()
  await expectNoCodePrompt(page)
  expect(await child.locator('html').evaluate(async () => {
    const blocked = (operation: () => void) => {try {operation(); return false} catch {return true}}
    const network = await fetch('https://nested-component-probe.example/read').then(() => false, () => true)
    return {
      parent: blocked(() => {void window.parent.document.title}),
      local: blocked(() => {localStorage.setItem('nested-probe', 'blocked')}),
      session: blocked(() => {sessionStorage.setItem('nested-probe', 'blocked')}),
      network,
    }
  })).toEqual({parent: true, local: true, session: true, network: true})
  expect(reached).toEqual([])
  expect(state.bundle.files.map(file => file.content)).toEqual(original)
  expect(fake.requests.some(request => /save_files|share_project|accept_invitation/.test(request.url()))).toBe(false)
})

test('an image file can be shared directly and still has its own comment discussion', async ({page}) => {
  const shared = bundle('', 'photo.png')
  shared.images.push({path: 'photo.png', dataURL: PNG, width: 1, height: 1, preview: {dataURL: PNG, width: 1, height: 1}})
  await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(page.getByRole('img', {name: 'photo.png', exact: true})).toBeVisible()
  await expect(page.locator(FRAME)).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Export', exact: true})).toHaveCount(0)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toBeVisible()
})

test('a directly shared drawing keeps its drawing view without offering a note export', async ({page}) => {
  await setup(page, {bundle: bundle(EXPORT_DRAWING, 'board.excalidraw')})
  await page.goto(href)
  await expect(page.getByRole('img', {name: 'Shared drawing board.excalidraw', exact: true})).toBeVisible({timeout: 45_000})
  await expect(page.getByRole('button', {name: 'Export', exact: true})).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Comments', exact: true})).toBeVisible()
})

const FORM_MODULE = `import {useState} from 'react'

export function FormDemo() {
  const [name, setName] = useState('')
  const [result, setResult] = useState('No greeting yet')
  const [attempted, setAttempted] = useState('No programmatic attempt')
  const submitNative = (id, request) => {
    try {
      const form = document.getElementById(id)
      if (request) form.requestSubmit()
      else form.submit()
    } catch {
      // Firefox may throw a nameless native CSP refusal. The browser test
      // requires a fresh form-action violation after every attempted call.
    }
    setAttempted(request ? 'requestSubmit attempted' : 'submit attempted')
  }
  return <div>
    <form onSubmit={event => {event.preventDefault(); setResult('Hello ' + name)}}>
      <label htmlFor="visitor-name">Your name</label>
      <input id="visitor-name" value={name} onChange={event => setName(event.target.value)} />
      <button type="submit">Show greeting</button>
    </form>
    <p role="status" aria-label="Greeting result">{result}</p>
    <form id="external-get" action="https://form-probe.example/get" method="get">
      <input type="hidden" name="payload" value="test-value" />
      <button type="submit">Unhandled GET</button>
    </form>
    <form id="external-post" action="https://form-probe.example/post" method="post">
      <input type="hidden" name="payload" value="test-value" />
      <button type="submit">Unhandled POST</button>
    </form>
    <button type="button" onClick={() => submitNative('external-post', false)}>Programmatic submit</button>
    <button type="button" onClick={() => submitNative('external-get', true)}>Programmatic requestSubmit</button>
    <p role="status" aria-label="Form submission attempt">{attempted}</p>
  </div>
}
`

async function sharedForm(page: Page) {
  const shared = bundle('import {FormDemo} from "workspace:forms/form-demo.mdx"\n\n# Interactive shared form\n\n<FormDemo />')
  shared.files.push({id: crypto.randomUUID(), path: 'forms/form-demo.mdx', content: FORM_MODULE, version: 7})
  const setupResult = await setup(page, {bundle: shared})
  await page.goto(href)
  await expect(frame(page).getByLabel('Your name')).toBeVisible({timeout: 20_000})
  await expectNoCodePrompt(page)
  return setupResult
}

test('a native form in a shared custom component keeps local state and handles preventDefault submission', async ({page}) => {
  const {state, fake} = await sharedForm(page)
  const original = state.bundle.files.map(file => file.content)
  await frame(page).getByLabel('Your name').fill('Ada')
  await frame(page).getByRole('button', {name: 'Show greeting', exact: true}).click()
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('Hello Ada')
  await frame(page).getByLabel('Your name').fill('Grace')
  await frame(page).getByLabel('Your name').press('Enter')
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('Hello Grace')
  expect(state.bundle.files.map(file => file.content)).toEqual(original)
  expect(fake.requests.some(request => /save_files|save_file/.test(request.url()))).toBe(false)
  expect(state.calls.every(call => call.name === 'read' || call.name === 'list_file_share_comments')).toBe(true)
})

test('unhandled and programmatic native form submissions cannot send data or navigate the isolated shared view', async ({page}) => {
  const reached: string[] = []
  await page.route('https://form-probe.example/**', route => {
    reached.push(route.request().url())
    return route.fulfill({status: 200, contentType: 'text/html', body: '<h1>Form escaped</h1>'})
  })
  const {state, fake} = await sharedForm(page)
  const original = state.bundle.files.map(file => file.content)
  const initialFrameURL = await frame(page).locator('html').evaluate(() => location.href)
  await frame(page).locator('html').evaluate(() => {
    const state = window as unknown as {formViolations: string[]}
    state.formViolations = []
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'form-action') state.formViolations.push(event.blockedURI)
    })
  })
  let attempts = 0
  for (const name of ['Unhandled GET', 'Unhandled POST', 'Programmatic submit', 'Programmatic requestSubmit']) {
    await frame(page).getByRole('button', {name, exact: true}).click()
    await expect(frame(page).getByLabel('Your name')).toBeVisible()
    if (name === 'Programmatic submit') await expect(frame(page).getByRole('status', {name: 'Form submission attempt'})).toHaveText('submit attempted')
    if (name === 'Programmatic requestSubmit') await expect(frame(page).getByRole('status', {name: 'Form submission attempt'})).toHaveText('requestSubmit attempted')
    attempts++
    await expect.poll(() => frame(page).locator('html').evaluate(() =>
      (window as unknown as {formViolations: string[]}).formViolations.length)).toBe(attempts)
  }
  // A refused form navigation has no response to await. Give a wrongly
  // permitted navigation a turn to reach the intercepted external origin.
  await page.waitForTimeout(300)
  expect(reached).toEqual([])
  expect(await frame(page).locator('html').evaluate(() => location.href)).toBe(initialFrameURL)
  await expect(page).toHaveURL(href)
  await expect(frame(page).getByRole('status', {name: 'Greeting result'})).toHaveText('No greeting yet')
  expect(state.bundle.files.map(file => file.content)).toEqual(original)
  expect(fake.requests.some(request => /save_files|save_file/.test(request.url()))).toBe(false)
  expect(state.calls.every(call => call.name === 'read' || call.name === 'list_file_share_comments')).toBe(true)
})

for (const width of [390, 1280]) test(`a fixed-position modal in a long interactive shared note opens fully in the viewport at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900})
  const content = `import {useState} from 'react'

export function DetailsModal() {
  const [open, setOpen] = useState(false)
  return <div>
    <button type="button" onClick={() => setOpen(true)}>Open details</button>
    {open ? <div role="dialog" aria-modal="true" aria-label="Form details" style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%, -50%)',width:280,padding:24,background:'white',color:'black',border:'1px solid black',zIndex:1000}}>
      <h2>Form details</h2>
      <p>The modal belongs in the visible preview.</p>
      <button type="button" onClick={() => setOpen(false)}>Done</button>
    </div> : null}
  </div>
}

# Shared guide

<DetailsModal />

${'Read a paragraph in this long interactive document.\n\n'.repeat(65)}`
  await setup(page, {bundle: bundle(content)})
  await page.goto(href)
  await expect(frame(page).getByRole('button', {name: 'Open details', exact: true})).toBeVisible()
  await expectNoCodePrompt(page)
  await frame(page).getByRole('button', {name: 'Open details', exact: true}).click()
  const modal = frame(page).getByRole('dialog', {name: 'Form details'})
  await expect(modal).toBeAttached()
  // Bounding boxes do not scroll controls into view, so this catches a fixed
  // modal centered thousands of pixels below the browser in a tall iframe.
  const box = (await modal.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  await modal.getByRole('button', {name: 'Done', exact: true}).click()
  await expect(modal).toHaveCount(0)
})

for (const width of [390, 1280]) test(`posting asks for sign-in and restores the selection, draft, and reading position at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900})
  const shared = bundle(`# Shared guide\n\n${'Read this paragraph before reviewing the later section.\n\n'.repeat(45)}## Review this section\n\nFeedback belongs here.`)
  const {state, fake} = await setup(page, {bundle: shared})
  await page.goto(href)
  const heading = frame(page).getByRole('heading', {name: 'Review this section'})
  await heading.scrollIntoViewIfNeeded()
  await heading.hover()
  await page.getByRole('button', {name: 'Comment on section'}).click()
  await expect(panel(page).locator('blockquote')).toContainText('Review this section')
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Keep my feedback through sign-in.')
  await expect(page).toHaveURL(href)
  const scroll = await frame(page).locator('html').evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  await panel(page).getByRole('button', {name: 'Sign in to post'}).click()
  await expect(page).toHaveURL(new URL(`sign-in?next=%2Fs%2F${TOKEN}`, APP_URL).href)
  await page.getByRole('button', {name: 'Use a password instead'}).click()
  await page.getByLabel('Email', {exact: true}).fill(person.email)
  await page.getByLabel('Password', {exact: true}).fill('a password')
  await page.getByRole('button', {name: 'Sign in', exact: true}).click()
  await expect(page).toHaveURL(href)
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveValue('Keep my feedback through sign-in.')
  await expect(panel(page).locator('blockquote')).toContainText('Review this section')
  await expect.poll(() => frame(page).locator('html').evaluate(() => window.scrollY), {timeout: 10_000}).toBeGreaterThan(scroll * 0.7)
  if (width < 650) {
    await panel(page).getByRole('button', {name: 'Close comments', exact: true}).click()
    await expect(panel(page)).toHaveCount(0)
  }
  await expect(frame(page).getByRole('heading', {name: 'Review this section'})).toBeInViewport()
  if (width < 650) {
    await page.getByRole('button', {name: 'Comments', exact: true}).click()
    await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveValue('Keep my feedback through sign-in.')
  }
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  await expect(panel(page).getByText('Keep my feedback through sign-in.', {exact: true})).toBeVisible()
  const posted = state.calls.find(c => c.name === 'add_file_share_comment')!
  expect(posted.args).toMatchObject({file_version: 7, body: 'Keep my feedback through sign-in.', anchor: {kind: 'section', quote: {exact: '## Review this section'}}})
  expect(fake.server.projects.size).toBe(0)
  expect(fake.requests.some(r => /accept_invitation|share_project/.test(r.url()))).toBe(false)
})

test('signing in from a long interactive note restores its internal reading position for a whole-file comment', async ({page}) => {
  const content = `export const LocalGreeting = () => <span>Interactive note</span>\n\n# Shared guide\n\n<LocalGreeting />\n\n${'A short paragraph to read before the later section.\n\n'.repeat(65)}## Return to this part\n\nRead from here after signing in.`
  const {state} = await setup(page, {bundle: bundle(content)})
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await expectNoCodePrompt(page)
  await frame(page).getByRole('heading', {name: 'Return to this part'}).scrollIntoViewIfNeeded()
  const readPosition = await frame(page).locator('html').evaluate(() => window.scrollY)
  expect(readPosition).toBeGreaterThan(1000)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Feedback from this reading position.')
  await panel(page).getByRole('button', {name: 'Sign in to post'}).click()
  await expect(page).toHaveURL(new URL(`sign-in?next=%2Fs%2F${TOKEN}`, APP_URL).href)
  const sourceOffset = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`elaborating.shared-comment.v1:${id}`)!).sourceOffset as number, SHARE)
  expect(sourceOffset).toBeGreaterThan(content.length / 2)
  await page.getByRole('button', {name: 'Use a password instead'}).click()
  await page.getByLabel('Email', {exact: true}).fill(person.email)
  await page.getByLabel('Password', {exact: true}).fill('a password')
  await page.getByRole('button', {name: 'Sign in', exact: true}).click()
  await expect(page).toHaveURL(href)
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveValue('Feedback from this reading position.')
  await expect.poll(() => frame(page).locator('html').evaluate(() => window.scrollY), {timeout: 15_000}).toBeGreaterThan(readPosition * 0.7)
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  await expect(panel(page).getByText('Feedback from this reading position.', {exact: true})).toBeVisible()
  expect(state.calls.find(call => call.name === 'add_file_share_comment')?.args.anchor).toEqual({kind: 'document'})
})

test('signed-in visitors can post, reply, edit, resolve, reopen, and remove their own comment', async ({page}) => {
  const {state, fake} = await setup(page, {signedIn: true})
  await page.goto(href)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  await panel(page).getByRole('textbox', {name: 'New comment'}).fill('Initial feedback')
  await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
  const thread = panel(page).getByRole('article').first()
  await expect(thread.getByText('Initial feedback', {exact: true})).toBeVisible()
  await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveCount(0)
  await thread.getByRole('button', {name: 'Reply', exact: true}).click()
  await thread.getByRole('textbox', {name: 'Reply', exact: true}).fill('A useful reply')
  await thread.getByRole('button', {name: 'Reply', exact: true}).last().click()
  await expect(thread.getByText('A useful reply', {exact: true})).toBeVisible()
  await thread.getByRole('button', {name: 'Actions for the comment by Visitor'}).last().click()
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).click()
  await thread.getByRole('textbox', {name: 'Edit comment'}).fill('A revised reply')
  await thread.getByRole('button', {name: 'Save', exact: true}).click()
  await expect(thread.getByText('A revised reply', {exact: true})).toBeVisible()
  await thread.getByRole('button', {name: 'Resolve', exact: true}).click()
  await panel(page).getByRole('button', {name: /Resolved/}).click()
  await panel(page).getByRole('button', {name: 'Reopen', exact: true}).click()
  await thread.getByRole('button', {name: 'Actions for the comment by Visitor'}).last().click()
  await page.getByRole('menuitem', {name: 'Delete', exact: true}).click()
  await page.getByRole('alertdialog').getByRole('button', {name: 'Delete', exact: true}).click()
  await expect(thread.getByText('Comment deleted', {exact: true})).toBeVisible()
  expect(new Set(state.calls.filter(c => c.name !== 'read').map(c => c.name))).toEqual(new Set([
    'list_file_share_comments','add_file_share_comment','reply_file_share_comment','edit_file_share_comment','resolve_file_share_thread','delete_file_share_comment',
  ]))
  expect(fake.server.projects.size).toBe(0)
})

test('two consecutive comments close their composers and use different thread and comment identities', async ({page}) => {
  const {state} = await setup(page, {signedIn: true})
  await page.goto(href)
  const bodies = ['First separate comment', 'Second separate comment']
  for (const body of bodies) {
    await page.getByRole('button', {name: 'Add comment', exact: true}).click()
    await panel(page).getByRole('textbox', {name: 'New comment'}).fill(body)
    await panel(page).getByRole('button', {name: 'Comment', exact: true}).click()
    await expect(panel(page).getByText(body, {exact: true})).toBeVisible()
    await expect(panel(page).getByRole('textbox', {name: 'New comment'})).toHaveCount(0)
  }
  const writes = state.calls.filter(call => call.name === 'add_file_share_comment')
  expect(writes).toHaveLength(2)
  expect(new Set(writes.map(call => call.args.thread_id)).size).toBe(2)
  expect(new Set(writes.map(call => call.args.comment_id)).size).toBe(2)
  for (const {args} of writes) {
    expect(args.thread_id).toMatch(/^[a-f0-9-]{36}$/)
    expect(args.comment_id).toMatch(/^[a-f0-9-]{36}$/)
  }
  expect(state.threads.map(thread => thread.comments[0].body)).toEqual(bodies)
  for (const body of bodies) await expect(panel(page).getByText(body, {exact: true})).toBeVisible()
})

test('revoking a link clears an already-open file on the next focus check', async ({page, appErrors}) => {
  appErrors.expect('This link is unavailable.')
  const {state} = await setup(page)
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  state.revoked = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  await expect(page.locator(FRAME)).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Add comment'})).toHaveCount(0)
})

test('an unavailable link explains itself and an archived file stays readable without comment actions', async ({page, appErrors}) => {
  appErrors.expect('This link is unavailable.')
  const {state} = await setup(page)
  state.revoked = true
  await page.goto(href)
  await expect(page.getByRole('heading', {name: 'Shared file unavailable'})).toBeVisible()
  state.revoked = false
  state.bundle.share.archived = true
  await page.getByRole('button', {name: 'Try again'}).click()
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  await expect(page.getByText('This project is archived. Comments are read only.').first()).toBeVisible()
  await expect(page.getByRole('button', {name: 'Add comment'})).toHaveCount(0)
  await page.getByRole('button', {name: 'Comments', exact: true}).click()
  await expect(panel(page).getByRole('textbox')).toHaveCount(0)
})

for (const width of [390, 1280]) test(`the shared document fills the viewport and floating comments work at ${width}px with no axe violations`, async ({page}) => {
  await page.setViewportSize({width, height: 900})
  const lastLine = 'This final paragraph stays clear of the floating controls.'
  await setup(page, {threads: discussionThreads(12), bundle: bundle(`# Shared guide\n\n${'A paragraph in the full-height reading view.\n\n'.repeat(40)}${lastLine}`)})
  await page.goto(href)
  await expect(frame(page).getByRole('heading', {name: 'Shared guide'})).toBeVisible({timeout: 20_000})
  const preview = page.locator(FRAME).first()
  const before = (await preview.boundingBox())!
  expect(before.y).toBeGreaterThanOrEqual(-1)
  expect(before.y).toBeLessThanOrEqual(16)
  expect(before.height).toBeGreaterThanOrEqual(900 - 32)
  expect(before.y + before.height).toBeLessThanOrEqual(901)
  expect(before.width).toBeGreaterThanOrEqual(width - 32)
  const controlsTop: number[] = []
  for (const name of ['Comments', 'Add comment', 'Export']) {
    const box = (await page.getByRole('button', {name, exact: true}).boundingBox())!
    expect(box.width).toBeLessThanOrEqual(name === 'Export' ? 180 : 48)
    expect(box.height).toBeLessThanOrEqual(48)
    expect(box.y).toBeGreaterThan(900 / 2)
    expect(box.y + box.height).toBeLessThanOrEqual(900)
    controlsTop.push(box.y)
  }
  await frame(page).locator('html').evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, document.documentElement.scrollHeight)
  })
  const eof = frame(page).getByText(lastLine, {exact: true})
  await expect(eof).toBeInViewport()
  const eofBox = (await eof.boundingBox())!
  expect(eofBox.y + eofBox.height).toBeLessThan(Math.min(...controlsTop))
  await page.getByRole('button', {name: 'Comments', exact: true}).click()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('article')).toHaveCount(12)
  const open = (await preview.boundingBox())!
  expect(Math.abs(open.y - before.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(open.height - before.height)).toBeLessThanOrEqual(1)
  if (width < 650) expect(Math.abs(open.width - before.width)).toBeLessThanOrEqual(1)
  else expect(open.width).toBeLessThan(before.width - 280)
  await expect.poll(async () => {
    const box = await panel(page).boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(901)
  const rail = (await panel(page).boundingBox())!
  expect(rail.x).toBeGreaterThanOrEqual(0)
  expect(rail.y).toBeGreaterThanOrEqual(0)
  expect(rail.x + rail.width).toBeLessThanOrEqual(width + 1)
  expect(rail.y + rail.height).toBeLessThanOrEqual(901)
  const last = panel(page).getByRole('article').last()
  await expect(last).not.toBeInViewport()
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await panel(page).getByRole('button', {name: 'Close comments', exact: true}).click()
  await expect(panel(page)).toHaveCount(0)
  await expect.poll(async () => (await preview.boundingBox())?.width).toBe(before.width)
  await page.getByRole('button', {name: 'Add comment', exact: true}).click()
  const field = panel(page).getByRole('textbox', {name: 'New comment'})
  await field.fill('Keep this draft when I close comments.')
  const submit = panel(page).getByRole('button', {name: 'Sign in to post', exact: true})
  await submit.scrollIntoViewIfNeeded()
  await expect(submit).toBeInViewport()
  const submitBox = (await submit.boundingBox())!
  expect(submitBox.y).toBeGreaterThanOrEqual(0)
  expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(901)
  expect(Math.abs((await preview.boundingBox())!.height - before.height)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await panel(page).getByRole('button', {name: 'Close comments', exact: true}).click()
  await expect(panel(page)).toHaveCount(0)
  await page.getByRole('button', {name: 'Comments', exact: true}).click()
  await expect(field).toHaveValue('Keep this draft when I close comments.')
  await expect(submit).toBeInViewport()
  await expect(panel(page)).toHaveCSS('opacity', '1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const result = await new AxeBuilder({page}).analyze()
  expect(result.violations.map(v => ({id: v.id, targets: v.nodes.map(n => n.target)}))).toEqual([])
})
