import { readFileSync } from 'node:fs'
import LZString from 'lz-string'
import { expect, test, type Page } from './fixtures.ts'
import { APP_URL } from './urls.ts'
import { PREVIEW_ASSETS, PREVIEW_BUILD, PREVIEW_ENTRY } from '../../supabase/functions/mcp-server/tools/previewManifest.ts'
import { PREVIEW_PROFILE, type PreviewRenderJob, type PreviewRenderReply } from '../../src/agent-preview/protocol.ts'

const identity = { job_id: '00000000-0000-4000-8000-000000000001', input_digest: 'a'.repeat(64), renderer_build: PREVIEW_BUILD, profile: PREVIEW_PROFILE }
const job = (source: string, extra: Partial<PreviewRenderJob> = {}): PreviewRenderJob => ({ ...identity, kind: 'drawing', path: 'drawing.excalidraw', source, canvas: null, layout: null, region: null, ...extra })
const rectangle = (id: string, x: number, y: number, width: number, height: number, color: string, extra = {}) => ({ id, type: 'rectangle', x, y, width, height,
  strokeColor: color, backgroundColor: color, fillStyle: 'solid', strokeWidth: 1, roughness: 0, angle: 0, opacity: 100, seed: 1, ...extra })
const blue = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#0000ff"/></svg>').toString('base64')}`
const drawing = JSON.stringify({ type: 'excalidraw', version: 2, appState: { viewBackgroundColor: '#ffffff' }, elements: [
  { ...rectangle('container', -200, -100, 300, 200, '#999999'), type: 'frame', name: 'Container' },
  rectangle('clipped-red', -250, -150, 450, 300, '#ff0000', { frameId: 'container' }),
  { id: 'words', type: 'text', x: -170, y: -70, width: 150, height: 25, text: 'Native font', originalText: 'Native font', fontFamily: 5, fontSize: 20, strokeColor: '#000000', frameId: 'container' },
  rectangle('green', 500, 0, 80, 80, '#00ff00'),
  { id: 'picture', type: 'image', x: 520, y: 120, width: 60, height: 60, fileId: 'picture:punctuation', status: 'saved', scale: [1, 1] },
], files: { 'picture:punctuation': { id: 'picture:punctuation', mimeType: 'image/svg+xml', created: 1, dataURL: blue } } })

async function openRenderer(page: Page) {
  const external: string[] = [], fonts: string[] = [], asked: string[] = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(APP_URL).origin) external.push(response.url())
    if (response.ok() && /\/excalidraw-assets\/fonts\//.test(url.pathname)) fonts.push(url.pathname)
  })
  page.on('request', request => asked.push(request.url()))
  await page.goto(new URL(PREVIEW_ENTRY, APP_URL).href)
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready', 'true')
  return { external, fonts, asked }
}

async function render(page: Page, input: PreviewRenderJob) {
  return page.evaluate(input => window.renderAgentPreview(input), input)
}

async function picture(page: Page, reply: PreviewRenderReply) {
  if (!('png' in reply)) throw new Error(JSON.stringify(reply))
  return page.evaluate(async png => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data
    let red = 0, green = 0, blue = 0, magenta = 0
    const redBounds = [Infinity, Infinity, -Infinity, -Infinity]
    for (let index = 0; index < bytes.length; index += 4) {
      const [r, g, b] = [bytes[index], bytes[index + 1], bytes[index + 2]]
      if (r > 220 && g < 30 && b < 30) {
        red++
        const x = index / 4 % canvas.width, y = Math.floor(index / 4 / canvas.width)
        redBounds[0] = Math.min(redBounds[0], x); redBounds[1] = Math.min(redBounds[1], y)
        redBounds[2] = Math.max(redBounds[2], x); redBounds[3] = Math.max(redBounds[3], y)
      }
      if (r < 30 && g > 220 && b < 30) green++
      if (r < 30 && g < 30 && b > 220) blue++
      if (r > 220 && g < 30 && b > 220) magenta++
    }
    return { width: canvas.width, height: canvas.height, red, green, blue, magenta, redBounds }
  }, reply.png)
}

test('standalone native preview keeps frame clipping, fonts and private images with an exact normalized crop', async ({ page }) => {
  test.setTimeout(90_000)
  const network = await openRenderer(page)
  const overview = await render(page, job(drawing))
  expect(overview.outcome.status, JSON.stringify(overview.outcome)).toBe('ready')
  if (overview.outcome.status !== 'ready') return
  const all = await picture(page, overview)
  expect(all.red).toBeGreaterThan(10000)
  expect(all.green).toBeGreaterThan(1000)
  expect(all.blue).toBeGreaterThan(1000)
  // The red child extends outside the frame in the source. Native clipping
  // keeps its visible width and height inside the frame's 300 by 200 box.
  expect(all.redBounds[2] - all.redBounds[0]).toBeLessThanOrEqual(Math.ceil(300 * overview.outcome.scale))
  expect(all.redBounds[3] - all.redBounds[1]).toBeLessThanOrEqual(Math.ceil(200 * overview.outcome.scale))
  const crop = await render(page, job(drawing, { region: { x: 0.5, y: 0, width: 0.5, height: 1 } }))
  expect(crop.outcome.status, JSON.stringify(crop.outcome)).toBe('ready')
  const part = await picture(page, crop)
  expect(part.red).toBe(0)
  expect(part.green).toBe(all.green)
  expect(part.blue).toBe(all.blue)
  expect(part.width).toBe(all.width / 2)
  expect(part.height).toBe(all.height)
  expect(network.fonts.length).toBeGreaterThan(0)
  expect(network.external).toEqual([])
  expect(await page.locator('.excalidraw, .monaco-editor, canvas').count()).toBe(0)
  expect(await page.evaluate(() => ({ frames: window.frames.length, storage: localStorage.length }))).toEqual({ frames: 0, storage: 0 })
})

test('compressed Obsidian is supported while malformed, excessive and external-image inputs fail without fetching', async ({ page }) => {
  test.setTimeout(90_000)
  const network = await openRenderer(page)
  const compressed = `before\n\`\`\`compressed-json\n${LZString.compressToBase64(drawing)}\n\`\`\`\nafter`
  const ready = await render(page, job(compressed, { path: 'drawing.excalidraw.md' }))
  expect(ready.outcome.status, JSON.stringify(ready.outcome)).toBe('ready')
  const malformed = await render(page, job('not a drawing'))
  expect(malformed.outcome).toMatchObject({ status: 'error', code: 'invalid_input' })
  const excessive = JSON.stringify({ elements: [rectangle('a', 0, 0, 100000, 100000, '#ffffff', { fillStyle: 'dots' })] })
  expect((await render(page, job(excessive))).outcome).toMatchObject({ status: 'error', code: 'limit' })
  const remote = JSON.parse(drawing)
  remote.files['picture:punctuation'].dataURL = 'https://example.invalid/private.png'
  expect((await render(page, job(JSON.stringify(remote)))).outcome).toMatchObject({ status: 'error', code: 'invalid_input' })
  const validPNG = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2; canvas.height = 2
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png')
  })
  const corruptBytes = Buffer.from(validPNG.split(',')[1], 'base64')
  for (let offset = 8; offset + 12 <= corruptBytes.length;) {
    const length = corruptBytes.readUInt32BE(offset)
    if (corruptBytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') corruptBytes.fill(0, offset + 8, offset + 8 + length)
    offset += length + 12
  }
  const corrupt = JSON.parse(drawing)
  corrupt.files['picture:punctuation'] = { id: 'picture:punctuation', mimeType: 'image/png', created: 1, dataURL: `data:image/png;base64,${corruptBytes.toString('base64')}` }
  const unreadable = await render(page, job(JSON.stringify(corrupt)))
  expect(unreadable.outcome).toMatchObject({ status: 'error', code: 'invalid_input' })
  if (unreadable.outcome.status === 'error') expect(unreadable.outcome.message).toContain('could not be decoded')
  const prototype = '{"elements":[],"customData":{"__proto__":{"polluted":true}}}'
  expect((await render(page, job(prototype))).outcome).toMatchObject({ status: 'error', code: 'invalid_input' })
  expect(await page.evaluate(() => Object.hasOwn(Object.prototype, 'polluted'))).toBe(false)
  expect(network.asked.some(url => url.includes('example.invalid'))).toBe(false)
  expect(network.external).toEqual([])
})

test('D2 previews share saved projection, preserve manual additions when stale, compile missing scenes and report syntax errors', async ({ page }) => {
  test.setTimeout(120_000)
  const network = await openRenderer(page)
  const saved = JSON.parse(readFileSync(new URL('./chat-card-diagram.json', import.meta.url), 'utf8')) as { source: string; canvas: string; layout: string }
  const canvas = JSON.parse(saved.canvas)
  canvas.elements.push(rectangle('manual-annotation', 1800, 1800, 100, 100, '#ff00ff'))
  const savedCanvas = JSON.stringify(canvas)
  const options = { kind: 'diagram' as const, path: 'flow.d2', canvas: savedCanvas, layout: saved.layout }
  const fresh = await render(page, job(saved.source, options))
  expect(fresh.outcome, JSON.stringify(fresh.outcome)).toMatchObject({ status: 'ready', regenerated: false, rendered_from: 'projected_diagram' })
  expect((await picture(page, fresh)).magenta).toBeGreaterThan(100)
  const stale = await render(page, job(`${saved.source}\npage.style.fill: "#fff3bf"\n`, options))
  expect(stale.outcome, JSON.stringify(stale.outcome)).toMatchObject({ status: 'ready', regenerated: true })
  expect((await picture(page, stale)).magenta).toBeGreaterThan(100)
  const missing = await render(page, job('a -> b: sends\n', { kind: 'diagram', path: 'new.d2' }))
  expect(missing.outcome, JSON.stringify(missing.outcome)).toMatchObject({ status: 'ready', regenerated: true })
  const broken = await render(page, job('a -> {\n', options))
  expect(broken.outcome, JSON.stringify(broken.outcome)).toMatchObject({ status: 'error', code: 'd2_error' })
  expect('png' in broken).toBe(false)
  const conflictingCanvas = JSON.parse(savedCanvas)
  conflictingCanvas.elements.find((element: { id: string }) => element.id === 'd2:page').strokeColor = '#ff0000'
  const conflicting = await render(page, job(`${saved.source}\npage.style.stroke: "#0000ff"\n`, { ...options, canvas: JSON.stringify(conflictingCanvas) }))
  expect(conflicting.outcome, JSON.stringify(conflicting.outcome)).toMatchObject({ status: 'error', code: 'd2_error' })
  if (conflicting.outcome.status === 'error') expect(conflicting.outcome.diagnostics[0].code).toBe('d2/merge-conflict')
  expect(network.external).toEqual([])
  expect(await page.locator('.excalidraw, .monaco-editor, canvas').count()).toBe(0)
})

test('the versioned native font worker returns real subset bytes without importing the renderer DOM entry', async ({ page }) => {
  const network = await openRenderer(page)
  const workers = PREVIEW_ASSETS.filter(asset => /\/native-subset-worker-[^/]+\.js$/.test(asset))
  const font = PREVIEW_ASSETS.find(asset => /\/excalidraw-assets\/fonts\/Excalifont\/[^/]+\.woff2$/.test(asset))
  expect(workers).toHaveLength(1)
  expect(font).toBeDefined()
  const result = await page.evaluate(async ({ worker, font }) => {
    const input = await (await fetch(font)).arrayBuffer()
    return new Promise<{ status: string; message?: string; inputBytes?: number; outputBytes?: number; signature?: string }>(resolve => {
      const subset = new Worker(worker, { type: 'module' })
      const done = (value: Parameters<typeof resolve>[0]) => { clearTimeout(timer); subset.terminate(); resolve(value) }
      const timer = setTimeout(() => done({ status: 'timeout' }), 15_000)
      subset.onerror = event => done({ status: 'error', message: event.message })
      subset.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => done({ status: 'ok', inputBytes: input.byteLength, outputBytes: data.byteLength, signature: String.fromCharCode(...new Uint8Array(data).subarray(0, 4)) })
      subset.postMessage({ command: 'SUBSET', arrayBuffer: input, codePoints: [65, 66, 67] })
    })
  }, { worker: workers[0], font: font! })
  expect(result).toMatchObject({ status: 'ok', signature: 'wOF2' })
  expect(result.outputBytes).toBeGreaterThan(0)
  expect(result.outputBytes).toBeLessThan(result.inputBytes!)
  expect(network.external).toEqual([])
})
