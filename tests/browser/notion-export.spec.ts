import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {unzipSync, strFromU8} from 'fflate'
import {DOMParser} from '@xmldom/xmldom'
import AxeBuilder from './axe.ts'
import {expect, test, type Download, type Page} from './fixtures.ts'
import {fakeSupabase, person, signedIn, SUPABASE} from './fake-supabase.ts'
import {APP_URL} from './urls.ts'
import {showView} from './views.ts'
import {inspectImage} from '../../src/features/images/format.ts'
import {imageDigest, imageObjectKeys, type ImageMediaType} from '../../src/features/images/types.ts'

test.use({viewport: {width: 1280, height: 900}})
test.describe.configure({timeout: 90_000})
const NOTE = 'notes/export.mdx'
const FRAME = 'iframe[title="Isolated document preview"]'
const frame = (page: Page) => page.frameLocator(FRAME).first()
const lines = (page: Page) => page.locator('.monaco-editor:visible .view-lines').first()
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
type SeedImage = {path: string; bytes: Buffer; type: ImageMediaType; preview?: Buffer}

async function open(page: Page, source: string, otherFiles: Record<string, string> = {}, images: SeedImage[] = []) {
  const fake = await fakeSupabase(page)
  const remote = fake.server.remote(person.id)
  const id = crypto.randomUUID()
  await remote.createProject(id, 'Notion export')
  await remote.saveFiles(id, crypto.randomUUID(), Object.entries({[NOTE]: source, ...otherFiles})
    .map(([path, content]) => ({op: 'put' as const, path, content})))
  for (const image of images) {
    const original = inspectImage(new Uint8Array(image.bytes), image.type)
    const preview = image.preview ?? pixel
    const size = inspectImage(new Uint8Array(preview), 'image/png')
    const assetId = crypto.randomUUID()
    const asset = await remote.uploadImage!(id, {id: assetId, ...imageObjectKeys(id, assetId), media_type: image.type,
      width: original.width, height: original.height, byte_length: image.bytes.length, sha256: await imageDigest(new Uint8Array(image.bytes)),
      preview_type: 'image/png', preview_byte_length: preview.length, preview_width: size.width, preview_height: size.height},
    new Blob([new Uint8Array(image.bytes)], {type: image.type}))
    fake.server.assets.get(`${id}/${asset.id}`)!.preview = new Blob([new Uint8Array(preview)], {type: 'image/png'})
    await remote.saveFiles(id, crypto.randomUUID(), [{op: 'asset', path: image.path, asset_id: asset.id}])
  }
  await signedIn(page)
  await page.goto(new URL(`projects/${id}/${NOTE}`, APP_URL).href)
  if ((page.viewportSize()?.width ?? 1280) < 650) await showView(page, 'Source')
  await expect(lines(page)).toBeVisible({timeout: 20_000})
  return {fake, id}
}

async function exportDialog(page: Page, format: 'Notion' | 'Google Docs' = 'Notion') {
  await page.getByRole('button', {name: 'File actions', exact: true}).click()
  await page.getByRole('menuitem', {name: `Export to ${format}`, exact: true}).click()
  const dialog = page.getByRole('dialog', {name: `Export to ${format}`, exact: true})
  await expect(dialog).toBeVisible()
  return dialog
}

async function unzip(download: Download) {
  return unzipSync(new Uint8Array(readFileSync((await download.path())!)))
}

async function exported(page: Page) {
  const dialog = await exportDialog(page)
  await dialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toBeVisible({timeout: 45_000})
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', {name: 'Download ZIP', exact: true}).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('export-notion.zip')
  const entries = await unzip(download)
  expect(Object.keys(entries).filter(path => path.endsWith('.html'))).toEqual(['export.html'])
  expect(Object.keys(entries).every(path => path === 'export.html' || /^assets\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(path))).toBe(true)
  return {dialog, entries, html: strFromU8(entries['export.html'])}
}

async function googleDocsExported(page: Page) {
  const dialog = await exportDialog(page, 'Google Docs')
  await dialog.getByRole('button', {name: 'Prepare export', exact: true}).click()
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toBeVisible({timeout: 45_000})
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', {name: 'Download DOCX', exact: true}).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('export-google-docs.docx')
  const entries = await unzip(download)
  expect(strFromU8(entries['[Content_Types].xml'])).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
  const xml = strFromU8(entries['word/document.xml'])
  const parsed = new DOMParser().parseFromString(xml, 'text/xml')
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const text = Array.from(parsed.getElementsByTagNameNS(word, 't')).map(node => node.textContent).join('')
  expect(xml).not.toContain('altChunk')
  return {dialog, entries, xml, parsed, text, word}
}

test('ordinary text, lists, code and tables stay editable HTML and current source drafts are included', async ({page}) => {
  const source = '# Editable export\n\nA **bold** paragraph and [useful link](https://example.com).\n\n3. First\n4. Next\n\n- [x] Done\n- [ ] Later\n\n```cpp\nint main() { return 0; }\n```\n\n| Name | State |\n| --- | --- |\n| Draft | Ready |\n'
  const {fake, id} = await open(page, source)
  await lines(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nCurrent unsaved paragraph.\n')
  await expect(page.getByRole('tab', {name: `${NOTE}, unsaved changes`, exact: true})).toBeVisible()
  const {entries, html, dialog} = await exported(page)
  expect(Object.keys(entries)).toEqual(['export.html'])
  expect(html).toContain('<h1>Editable export</h1>')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<ol start="3">')
  expect(html).toContain('type="checkbox" disabled="disabled" checked="checked"')
  expect(html).toContain('<pre><code class="language-cpp">int main() { return 0; }')
  expect(html).toContain('<th>Name</th><th>State</th>')
  expect(html).toContain('Current unsaved paragraph.')
  expect(html).not.toMatch(/<iframe|<script|contenteditable|monaco|Copy code|Export to Notion/)
  expect(fake.server.content(id, NOTE)).toBe(source)
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  // The first conversion has loaded its engines. Repeating it needs only
  // the browser's current document and those cached modules.
  await page.context().setOffline(true)
  try {
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    const offline = await exported(page)
    expect(Object.keys(offline.entries)).toEqual(['export.html'])
    expect(offline.entries['export.html']).toEqual(entries['export.html'])
    expect(fake.server.content(id, NOTE)).toBe(source)
  } finally {await page.context().setOffline(false)}
})

test('original image bytes, rich captions and SVG raster copies are included without unrelated project files', async ({page}) => {
  const pictures = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'; context.fillRect(0, 0, 1600, 900)
    context.fillStyle = 'black'
    for (let x = 0; x < 1600; x += 4) context.fillRect(x, 0, 1, 900)
    const original = canvas.toDataURL('image/png')
    const preview = document.createElement('canvas')
    preview.width = 480; preview.height = 270
    preview.getContext('2d')!.drawImage(canvas, 0, 0, 480, 270)
    return {original, preview: preview.toDataURL('image/png')}
  })
  const original = Buffer.from(pictures.original.split(',')[1], 'base64')
  const vector = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/></svg>')
  const source = '# Pictures\n\n<figure>\n\n![Detailed screenshot](../images/screenshot.png)\n\n<figcaption>\n\nA **clear** caption with [help](https://example.com).\n\n</figcaption>\n</figure>\n\n![Vector picture](../images/vector.svg)\n\n![Same screenshot](../images/screenshot.png)'
  await open(page, source, {'private/unrelated.txt': 'Never include this private marker.'}, [
    {path: 'images/screenshot.png', bytes: original, type: 'image/png', preview: Buffer.from(pictures.preview.split(',')[1], 'base64')},
    {path: 'images/vector.svg', bytes: vector, type: 'image/svg+xml'},
    {path: 'private/unused.png', bytes: pixel, type: 'image/png'},
  ])
  const {entries, html} = await exported(page)
  const refs = [...html.matchAll(/<img src="([^"]+)"/g)].map(match => match[1])
  expect(refs).toHaveLength(3)
  expect(refs[0]).toBe(refs[2])
  expect(Object.keys(entries)).toHaveLength(3)
  expect(Buffer.from(entries[refs[0]]).equals(original)).toBe(true)
  expect(inspectImage(entries[refs[0]])).toMatchObject({width: 1600, height: 900})
  expect(inspectImage(entries[refs[1]])).toMatchObject({mediaType: 'image/png', width: 100, height: 50, animated: false})
  expect(html).toContain('<figcaption><p>A <strong>clear</strong> caption')
  expect(html).not.toMatch(/data:|<svg|unrelated|unused|Never include/)
})

test('native drawings and saved D2 canvases become bounded PNG assets without external requests', async ({page}) => {
  const outside: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (/^https?:$/.test(url.protocol) && ![new URL(APP_URL).origin, new URL(SUPABASE).origin].includes(url.origin)) outside.push(url.href)
  })
  const scene = JSON.stringify({type: 'excalidraw', version: 2, appState: {}, files: {}, elements: [{
    id: 'rect', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
  }]})
  const saved = JSON.parse(readFileSync(join(import.meta.dirname, 'chat-card-diagram.json'), 'utf8')) as {source: string; canvas: string; layout: string}
  await open(page, '# Native pictures\n\n<Drawing src="art/sketch.excalidraw" />\n\n<Diagram src="art/flow.d2" />', {
    'art/sketch.excalidraw': scene, 'art/flow.d2': saved.source, 'art/flow.excalidraw': saved.canvas, 'art/flow.d2.json': saved.layout,
  })
  const {entries, html} = await exported(page)
  const assets = Object.keys(entries).filter(path => path.startsWith('assets/'))
  expect(assets).toHaveLength(2)
  for (const path of assets) {
    const image = inspectImage(entries[path], 'image/png')
    expect(image.width * image.height).toBeLessThanOrEqual(8_000_000)
    expect(entries[path].length).toBeLessThanOrEqual(5 * 1024 * 1024)
  }
  expect([...html.matchAll(/<img /g)]).toHaveLength(2)
  expect(html).not.toMatch(/<Drawing|<Diagram|\.excalidraw|\.d2\.json/)
  expect(outside).toEqual([])
})

test('collapsed unopened documents and a live unsaved child draft are expanded into the exported text', async ({page}) => {
  const childPath = 'notes/child.md'
  const childSource = '# Child detail\n\nEditable child paragraph.\n'
  const source = '# Parent\n\n<Document src="notes/child.md" title="Live detail" defaultCollapsed />\n\n<Document src="notes/unopened.md" title="Unopened detail" defaultCollapsed />'
  const {fake, id} = await open(page, source, {[childPath]: childSource, 'notes/unopened.md': '# Unopened child\n\nContent never opened on screen.'})
  await showView(page, 'Rendered')
  const embed = frame(page).locator(`[data-document-embed="${childPath}"]`)
  await expect(embed.getByRole('button', {name: 'Live detail', exact: true})).toHaveAttribute('aria-expanded', 'false')
  await expect(embed.locator('iframe')).toHaveCount(0)
  await embed.getByRole('button', {name: 'Live detail', exact: true}).click()
  const child = embed.frameLocator('iframe')
  const paragraph = child.getByText('Editable child paragraph.', {exact: true})
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' CURRENT DRAFT')
  await expect(child.getByText('Editable child paragraph. CURRENT DRAFT', {exact: true})).toBeVisible()
  await embed.getByRole('button', {name: 'Live detail', exact: true}).click()
  await expect(frame(page).locator('[data-document-embed="notes/unopened.md"] iframe')).toHaveCount(0)
  const {entries, html, dialog} = await exported(page)
  expect(Object.keys(entries)).toEqual(['export.html'])
  expect(html).toContain('Editable child paragraph. CURRENT DRAFT')
  expect(html).toContain('Content never opened on screen.')
  expect(html).not.toMatch(/<Document|Open separately|Save child|Run document/)
  await expect(dialog.getByRole('status').filter({hasText: /^Ready:/})).toHaveText('Ready: 3 documents and 0 images.')
  expect(fake.server.content(id, childPath)).toBe(childSource)
  expect(fake.server.content(id, NOTE)).toBe(source)
})

test('Google Docs exports real editable DOCX with unsaved root and child drafts, original images and cached offline repeat', async ({page}) => {
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 800; canvas.height = 450
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'; context.fillRect(0, 0, 800, 450)
    context.fillStyle = '#3153ec'; context.fillRect(10, 10, 780, 100)
    return canvas.toDataURL('image/png')
  })
  const original = Buffer.from(picture.split(',')[1], 'base64')
  const childPath = 'notes/google-child.md'
  const childSource = '# Google child\n\nEditable child paragraph.\n'
  const source = '# Google project export\n\nA **bold** root paragraph.\n\n| Item | State |\n| --- | --- |\n| Export | Ready |\n\n![Original project picture](../images/google.png)\n\n<Document src="notes/google-child.md" title="Current child" defaultCollapsed />\n\n<Document src="notes/google-unopened.md" title="Unopened child" defaultCollapsed />\n'
  const {fake, id} = await open(page, source, {
    [childPath]: childSource,
    'notes/google-unopened.md': '# Unopened Google child\n\nContent never opened before export.',
    'private/unrelated.txt': 'UNREFERENCED_PRIVATE_PROJECT_CONTENT',
  }, [{path: 'images/google.png', bytes: original, type: 'image/png'}])
  await lines(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nCURRENT ROOT DRAFT.\n')
  await expect(page.getByRole('tab', {name: `${NOTE}, unsaved changes`, exact: true})).toBeVisible()
  await showView(page, 'Rendered')
  const embed = frame(page).locator(`[data-document-embed="${childPath}"]`)
  await embed.getByRole('button', {name: 'Current child', exact: true}).click()
  const child = embed.frameLocator('iframe')
  const paragraph = child.getByText('Editable child paragraph.', {exact: true})
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' CURRENT CHILD DRAFT.')
  await expect(child.getByText('Editable child paragraph. CURRENT CHILD DRAFT.', {exact: true})).toBeVisible()
  const unopened = frame(page).locator('[data-document-embed="notes/google-unopened.md"]')
  await expect(unopened.locator('iframe')).toHaveCount(0)
  const requestStart = fake.requests.length
  const first = await googleDocsExported(page)
  await expect(first.dialog.getByRole('status').filter({hasText: /^Ready:/})).toHaveText('Ready: 3 documents and 1 image.')
  for (const content of ['Google project export', 'CURRENT ROOT DRAFT.', 'Editable child paragraph. CURRENT CHILD DRAFT.', 'Content never opened before export.'])
    expect(first.text).toContain(content)
  const headings = Array.from(first.parsed.getElementsByTagNameNS(first.word, 'pStyle')).some(style => /^heading-?1$/i.test(style.getAttributeNS(first.word, 'val') ?? '')) ||
    Array.from(first.parsed.getElementsByTagNameNS(first.word, 'outlineLvl')).some(level => level.getAttributeNS(first.word, 'val') === '0')
  expect(headings).toBe(true)
  expect(first.parsed.getElementsByTagNameNS(first.word, 'b').length).toBeGreaterThan(0)
  const table = first.parsed.getElementsByTagNameNS(first.word, 'tbl').item(0)!
  expect(table).not.toBeNull()
  expect(table.getElementsByTagNameNS(first.word, 'tc').length).toBeGreaterThanOrEqual(4)
  expect(table.textContent).toContain('Item')
  expect(table.textContent).toContain('Ready')
  const images = Object.keys(first.entries).filter(path => path.startsWith('word/media/'))
  expect(images).toHaveLength(1)
  expect(Buffer.from(first.entries[images[0]]).equals(original)).toBe(true)
  expect(inspectImage(first.entries[images[0]])).toMatchObject({width: 800, height: 450})
  const xmlFiles = Object.entries(first.entries).filter(([path]) => /\.(?:xml|rels)$/.test(path)).map(([, bytes]) => strFromU8(bytes)).join('\n')
  expect(xmlFiles).not.toMatch(/UNREFERENCED_PRIVATE_PROJECT_CONTENT|<script|<iframe|contenteditable|data:/)
  await first.dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  await expect(unopened.locator('iframe')).toHaveCount(0)
  await page.context().setOffline(true)
  try {
    const offline = await googleDocsExported(page)
    expect(offline.text).toBe(first.text)
    expect(Object.keys(offline.entries).filter(path => path.startsWith('word/media/')).some(path => Buffer.from(offline.entries[path]).equals(original))).toBe(true)
    await offline.dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  } finally {await page.context().setOffline(false)}
  // Choosing Notion afterward still produces the ordinary HTML/assets ZIP.
  const notion = await exported(page)
  expect(notion.html).toContain('CURRENT ROOT DRAFT.')
  expect(notion.html).toContain('Editable child paragraph. CURRENT CHILD DRAFT.')
  expect(notion.entries['word/document.xml']).toBeUndefined()
  expect(fake.server.content(id, NOTE)).toBe(source)
  expect(fake.server.content(id, childPath)).toBe(childSource)
  expect(fake.requests.slice(requestStart).some(request => /save_files|save_file|\/oauth\/|\/auth\/v1\/(?:token|authorize)/.test(request.url()))).toBe(false)
  expect(fake.requests.some(request => /^https:\/\/(?:docs|drive|accounts)\.google\.com\//.test(request.url()))).toBe(false)
})

const counter = `import {useState} from 'react'

export function ExportCounter() {
  const [count, setCount] = useState(0)
  return <section><h2>Custom counter</h2><p>Visible count: {count}</p><button type="button" onClick={() => setCount(count + 1)}>Increase counter</button></section>
}

# Component export

<ExportCounter />`

for (const mode of ['Rendered', 'Source'] as const) test(`custom components export their ${mode === 'Rendered' ? 'current interactive state' : 'fresh appearance without opening Rendered'}`, async ({page}) => {
  const source = mode === 'Source' ? `${counter}

export const CustomGraphic = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect width="200" height="100" fill="white" /><rect x="10" y="40" width="50" height="50" fill="blue" /><text x="10" y="20" fill="black">Chart detail</text></svg>

<CustomGraphic />` : counter
  const {fake, id} = await open(page, source)
  if (mode === 'Rendered') {
    await showView(page, 'Rendered')
    await frame(page).getByRole('button', {name: 'Increase counter', exact: true}).click()
    await frame(page).getByRole('button', {name: 'Increase counter', exact: true}).click()
    await expect(frame(page).getByText('Visible count: 2', {exact: true})).toBeVisible()
  } else await expect(page.locator(FRAME)).toHaveCount(0)
  const {entries, html, dialog} = await exported(page)
  if (mode === 'Source') {
    const assets = Object.keys(entries).filter(path => path.startsWith('assets/'))
    expect(assets).toHaveLength(1)
    expect(inspectImage(entries[assets[0]])).toMatchObject({mediaType: 'image/png', animated: false})
    expect(html).toContain(`<img src="${assets[0]}"`)
    expect(html).not.toMatch(/<svg|<CustomGraphic|&lt;CustomGraphic|SVG.*(?:omitted|unsupported|unavailable)/i)
    expect(await dialog.innerText()).not.toMatch(/SVG.*(?:omitted|unsupported|unavailable)/i)
  } else expect(Object.keys(entries)).toEqual(['export.html'])
  expect(html).toContain('<h2>Custom counter</h2>')
  expect(html).toContain(`Visible count: ${mode === 'Rendered' ? 2 : 0}`)
  expect(html).not.toMatch(/<ExportCounter|<button|onClick|useState|<script|<iframe/)
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  if (mode === 'Source') {
    await expect(lines(page)).toBeVisible()
    await expect(page.locator(FRAME)).toHaveCount(0)
  }
  expect(fake.server.content(id, NOTE)).toBe(source)
})

test('a live mixed Card retains reader content and full image pixels while excluding authoring controls', async ({page}) => {
  const dataURL = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 900
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'; context.fillRect(0, 0, 1600, 900)
    context.fillStyle = 'black'
    for (let x = 0; x < 1600; x += 4) context.fillRect(x, 0, 1, 900)
    return canvas.toDataURL('image/png')
  })
  const original = Buffer.from(dataURL.split(',')[1], 'base64')
  const source = `export const MixedCustomDetail = () => <p>Custom reader detail.</p>

# Mixed export

<Card>
<CardHeader>
<CardTitle>Mixed reader card</CardTitle>
</CardHeader>
<CardContent>

<MixedCustomDetail />

![Original reader screenshot](../images/mixed.png)

<Callout tone="warn" title="Remember the reader">

The actual callout body stays readable.

</Callout>

<Counter initial={13} step={4} />

\`\`\`cpp
const char* kept = "static code stays";
\`\`\`

</CardContent>
</Card>`
  const {fake, id} = await open(page, source, {}, [{path: 'images/mixed.png', bytes: original, type: 'image/png'}])
  await showView(page, 'Rendered')
  await expect(frame(page).getByText('Custom reader detail.', {exact: true})).toBeVisible()
  const image = frame(page).getByRole('button', {name: 'View image: Original reader screenshot', exact: true}).locator('img')
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1600)
  // These controls really exist in the editable view and must be removed
  // from the static copy without removing adjacent reader content.
  for (const name of ['Edit description', 'Edit caption', 'Replace image', 'Remove image'])
    await expect(frame(page).getByRole('button', {name, exact: true})).toHaveCount(1)
  await expect(frame(page).getByLabel('initial', {exact: true})).toHaveValue('13')
  await expect(frame(page).getByLabel('step', {exact: true})).toHaveValue('4')
  await expect(frame(page).getByLabel('title', {exact: true})).toHaveValue('Remember the reader')
  await expect(frame(page).getByLabel('tone', {exact: true})).toHaveValue('warn')
  await expect(frame(page).getByRole('button', {name: 'Copy code', exact: true})).toHaveCount(1)
  await frame(page).getByRole('button', {name: 'Increment', exact: true}).click()
  await frame(page).getByRole('button', {name: 'Increment', exact: true}).click()
  await expect(frame(page).locator('[data-component="Counter"] output')).toHaveText('21')
  const {entries, html} = await exported(page)
  const assets = Object.keys(entries).filter(path => path.startsWith('assets/'))
  const imageCopies = assets.filter(path => Buffer.from(entries[path]).equals(original))
  expect(imageCopies).toHaveLength(1)
  expect(inspectImage(entries[imageCopies[0]])).toMatchObject({width: 1600, height: 900})
  expect(html).toContain(`<img src="${imageCopies[0]}"`)
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const text = parsed.documentElement?.textContent ?? ''
  for (const content of ['Mixed reader card', 'Custom reader detail.', 'Remember the reader', 'The actual callout body stays readable.'])
    expect(text).toContain(content)
  expect(html).toContain('>21<')
  expect(Array.from(parsed.getElementsByTagName('code')).some(code => code.textContent?.includes('const char* kept = "static code stays";'))).toBe(true)
  expect(text).not.toMatch(/Edit description|Edit caption|Replace image|Remove image|Copy code|Edit code|\binitial\b|\bstep\b|\btitle\b|\btone\b|Computed output: edit in source/)
  expect(html).not.toMatch(/<input|<select|<button|contenteditable|data-authoring|&lt;MixedCustomDetail/)
  expect(fake.server.content(id, NOTE)).toBe(source)
})

test('export omits form secrets and active markup, refuses remote images, and visibly retains unsupported source', async ({page}) => {
  const reached: string[] = []
  await page.route('https://notion-export-probe.example/**', route => {reached.push(route.request().url()); return route.fulfill({body: 'Unexpected network access'})})
  const source = `import {useEffect} from 'react'

export const chosen = 'not-a-literal.excalidraw'
export function PrivacyDemo() {
  useEffect(() => {fetch('https://notion-export-probe.example/network').catch(() => {})}, [])
  return <section><h2>Printable component</h2><p>Public explanation.</p><form action="https://notion-export-probe.example/submit"><label>Email<input type="email" defaultValue="private@example.invalid" /></label><label>Password<input type="password" defaultValue="password-secret" /></label><textarea defaultValue="private form draft" /><button type="submit">Create account</button></form><script>window.privateScriptProbe = true</script></section>
}

# Safe package

<PrivacyDemo />

![Remote illustration](https://notion-export-probe.example/pixel.png)

<Drawing src={chosen} />`
  const {fake, id} = await open(page, source, {'private/secret.txt': 'Unreferenced private file marker.'})
  const {entries, html, dialog} = await exported(page)
  expect(Object.keys(entries)).toEqual(['export.html'])
  expect(html).toContain('<h2>Printable component</h2>')
  expect(html).toContain('Public explanation.')
  expect(html).toContain('Remote illustration unavailable')
  expect(html).toContain('&lt;Drawing src={chosen} /&gt;')
  expect(html).not.toMatch(/private@example|password-secret|private form draft|privateScriptProbe|Unreferenced private|<form|<input|<textarea|<button|<script|<iframe|action=|value=|notion-export-probe/)
  await expect(dialog.getByRole('list', {name: 'Export notes'})).toBeVisible()
  expect(reached).toEqual([])
  expect(fake.server.content(id, NOTE)).toBe(source)
})

test('the phone export dialog is accessible, Cancel changes nothing, and ordinary Export keeps the original MDX', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844})
  const source = '# Portable source\r\n\r\nA **bold** paragraph.\r\n\r\n<Note title="Keep MDX">Original source.</Note>\r\n'
  const {fake, id} = await open(page, source)
  let downloads = 0
  page.on('download', () => {downloads++})
  const first = await exportDialog(page)
  await expect(first).toHaveCSS('opacity', '1')
  const result = await new AxeBuilder({page}).include('[role="dialog"]').analyze()
  expect(result.violations.map(violation => ({id: violation.id, nodes: violation.nodes.map(node => node.target)}))).toEqual([])
  await first.getByRole('button', {name: 'Cancel', exact: true}).click()
  await expect(first).toHaveCount(0)
  expect(downloads).toBe(0)
  await expect(lines(page)).toContainText('Original source.')
  const {html, dialog} = await exported(page)
  expect(html).toContain('<h1>Portable source</h1>')
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', {name: 'Close', exact: true}).click()
  // Exercise the ordinary download fallback on both engines, without a
  // native operating-system file picker that Playwright cannot inspect.
  await page.evaluate(() => {Object.defineProperty(window, 'showSaveFilePicker', {configurable: true, value: undefined})})
  await page.getByRole('button', {name: 'File actions', exact: true}).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('menuitem', {name: 'Export', exact: true}).click()
  const raw = await pending
  expect(raw.suggestedFilename()).toBe('notes_export.mdx')
  expect(readFileSync((await raw.path())!, 'utf8')).toBe(source)
  expect(downloads).toBe(2)
  expect(fake.server.content(id, NOTE)).toBe(source)
})
