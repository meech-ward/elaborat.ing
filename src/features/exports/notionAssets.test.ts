import {expect, test} from 'bun:test'
import {createNotionAssets} from './notionAssets'
import type {WorkspaceFile, WorkspaceStore} from '../workbench/workspaceStore'
import {imageDataURL, MAX_IMAGE_BYTES} from '../images/types'

const decode = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))
const png = decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
const gif = decode('R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABAAgIACH5BAEKAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw==')
const webp = decode('UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoDAAIAAUAmJaACdLoB+AAFIQAA/su3/9lY+lY+lY/eC/770BvAwAAA')
const jpeg = decode('/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGiiivvDxD/9k=')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
const file = (path: string, content = '', kind: 'text' | 'image' = 'text'): WorkspaceFile => ({path, content, kind,
  savedContent: content, revision: 'snapshot', size: content.length, draft: false, unsynced: false, conflict: false, server: null})
const unavailable: Pick<WorkspaceStore, 'read' | 'readImage'> = {read: async path => {throw new Error(`Unexpected read: ${path}`)}}

/** A real PNG ancillary chunk keeps fixtures decodable while varying size and identity. */
function pngPayload(size: number, identity: number) {
  const extra = new Uint8Array(size + 12)
  const view = new DataView(extra.buffer)
  view.setUint32(0, size)
  extra.set(new TextEncoder().encode('tEXt'), 4)
  extra.set(new TextEncoder().encode(`id\0${identity}`), 8)
  let crc = 0xffffffff
  for (const byte of extra.subarray(4, size + 8)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  view.setUint32(size + 8, (crc ^ 0xffffffff) >>> 0)
  const result = new Uint8Array(png.length + extra.length)
  result.set(png.subarray(0, -12)); result.set(extra, png.length - 12); result.set(png.subarray(-12), result.length - 12)
  return result
}

test('raster originals retain exact bytes and detected types, with hash names and deduplication across paths', async () => {
  let reads = 0
  let downloads = 0
  const assets = createNotionAssets({
    read: async path => {reads++; return file(path, '', 'image')},
    readImage: async path => {downloads++; return new Blob([path.endsWith('.gif') ? gif : path.endsWith('.webp') ? webp : path.endsWith('.jpg') ? jpeg : png])},
  })
  const same = await Promise.all([assets.image('pictures/a.png'), assets.image('pictures/a.png'), assets.image('another/a.png')])
  expect(new Set(same).size).toBe(1)
  expect(reads).toBe(2)
  expect(downloads).toBe(2)
  expect(same[0]).toMatch(/^assets\/[a-f0-9]{64}\.png$/)
  expect(await assets.raster(imageDataURL(png, 'image/png'))).toBe(same[0])
  expect(await assets.image('animation.gif')).toMatch(/\.gif$/)
  expect(await assets.image('picture.webp')).toMatch(/\.webp$/)
  expect(await assets.image('picture.jpg')).toMatch(/\.jpg$/)
  expect(assets.files.map(asset => [...asset.bytes])).toEqual([[...png], [...gif], [...webp], [...jpeg]])
})

test('invalid project paths never reach the file store and no source name becomes a ZIP path', async () => {
  let reads = 0
  const assets = createNotionAssets({read: async path => {reads++; return file(path, '', 'image')}, readImage: async () => new Blob([png])})
  for (const path of ['../photo.png', '/photo.png', 'a/../photo.png', 'a\\photo.png', 'https://example.com/a.png', 'a\u0000.png', '.hidden/a.png']) {
    await expect(assets.image(path)).rejects.toThrow('inside this project')
    await expect(assets.drawing(path)).rejects.toThrow('inside this project')
    await expect(assets.diagram(path)).rejects.toThrow('inside this project')
  }
  expect(reads).toBe(0)
  expect(await assets.image('my photos/quote " # ? .png')).toMatch(/^assets\/[a-f0-9]{64}\.png$/)
})

test('custom snapshots reject URLs, vectors, mismatched media types and excessive pixels before browser decoding', async () => {
  const assets = createNotionAssets(unavailable)
  await expect(assets.raster('https://example.com/image.png')).rejects.toThrow()
  await expect(assets.raster(imageDataURL(new TextEncoder().encode(svg), 'image/svg+xml'))).rejects.toThrow('raster')
  await expect(assets.raster(imageDataURL(png, 'image/jpeg'))).rejects.toThrow('type')
  const huge = png.slice()
  new DataView(huge.buffer).setUint32(16, 8_000_001)
  await expect(assets.raster(imageDataURL(huge, 'image/png'))).rejects.toThrow('8 million')
  await expect(assets.raster(imageDataURL(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png'))).rejects.toThrow('5 MiB')
  expect(assets.files).toHaveLength(0)
})

test('export cancellation prevents reads and does not retain bytes after an in-flight download', async () => {
  const canceled = new AbortController()
  canceled.abort()
  await expect(createNotionAssets(unavailable, canceled.signal).image('a.png')).rejects.toHaveProperty('name', 'AbortError')
  const controller = new AbortController()
  const assets = createNotionAssets({read: async path => file(path, '', 'image'), readImage: async () => {controller.abort(); return new Blob([png])}}, controller.signal)
  await expect(assets.image('a.png')).rejects.toHaveProperty('name', 'AbortError')
  expect(assets.files).toHaveLength(0)
})

test('asset count and aggregate byte limits apply to unique bytes and do not discard earlier files', async () => {
  const count = createNotionAssets(unavailable)
  for (let index = 0; index < 256; index++) await count.raster(imageDataURL(pngPayload(8, index), 'image/png'))
  await expect(count.raster(imageDataURL(pngPayload(8, 256), 'image/png'))).rejects.toThrow('256')
  expect(count.files).toHaveLength(256)
  expect(await count.raster(imageDataURL(pngPayload(8, 0), 'image/png'))).toBe(count.files[0].path)
  const bytes = createNotionAssets(unavailable)
  for (let index = 0; index < 12; index++) await bytes.raster(imageDataURL(pngPayload(MAX_IMAGE_BYTES - png.length - 12, index), 'image/png'))
  await expect(bytes.raster(imageDataURL(pngPayload(MAX_IMAGE_BYTES - png.length - 12, 12), 'image/png'))).rejects.toThrow('64 MiB')
  expect(bytes.files).toHaveLength(12)
  expect(bytes.files.reduce((total, asset) => total + asset.bytes.length, 0)).toBe(60 * 1024 * 1024)
}, 15_000)

test('drawings refuse external image URLs and oversized source before importing a renderer', async () => {
  const scene = JSON.stringify({type: 'excalidraw', version: 2, elements: [{id: 'a', type: 'image', x: 0, y: 0}],
    files: {a: {id: 'a', mimeType: 'image/png', dataURL: 'https://example.com/private.png', created: 1}}})
  const assets = createNotionAssets({read: async path => file(path, path === 'big.excalidraw' ? ' '.repeat(2 * 1024 * 1024 + 1) : scene)})
  await expect(assets.drawing('unsafe.excalidraw')).rejects.toThrow('Choose a PNG, JPEG, WebP, GIF or SVG image.')
  await expect(assets.drawing('big.excalidraw')).rejects.toThrow('2 MiB')
  expect(assets.files).toHaveLength(0)
})

test('the complete native image table is checked against its aggregate pixel budget before any SVG decoder runs', async () => {
  let decodes = 0
  const restore = replaceGlobal('Image', class {src = ''; async decode() {decodes++; throw new Error('Unexpected image decoder')}})
  try {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="red"/></svg>')
    const scene = JSON.stringify({type: 'excalidraw', version: 2, elements: [{id: 'a', type: 'image', x: 0, y: 0}],
      files: Object.fromEntries(Array.from({length: 4}, (_, index) => [String(index), {id: String(index), mimeType: 'image/svg+xml', dataURL: imageDataURL(bytes, 'image/svg+xml'), created: 1}]))})
    const assets = createNotionAssets({read: async path => file(path, scene)})
    await expect(assets.drawing('large.excalidraw')).rejects.toThrow('24 million embedded image pixels')
    expect(decodes).toBe(0)
    expect(assets.files).toHaveLength(0)
  } finally {restore()}
})

function replaceGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value})
  return () => {if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name)}
}

test('validated SVG images become PNG while unsafe SVG is refused before any decoder sees it', async () => {
  let decodes = 0
  const restoreImage = replaceGlobal('Image', class {src = ''; async decode() {decodes++}})
  const restoreDocument = replaceGlobal('document', {createElement: () => ({getContext: () => ({drawImage() {}}), toBlob: (done: (blob: Blob) => void) => done(new Blob([png], {type: 'image/png'}))})})
  try {
    const assets = createNotionAssets({read: async path => file(path, '', 'image'), readImage: async path => new Blob([path === 'safe.svg' ? svg : '<svg width="20" height="10"><image href="https://example.com/a.png"/></svg>'], {type: 'image/svg+xml'})})
    expect(await assets.image('safe.svg')).toMatch(/\.png$/)
    expect(assets.files[0].bytes).toEqual(png)
    await expect(assets.image('unsafe.svg')).rejects.toThrow('image')
    expect(decodes).toBe(1)
  } finally {restoreDocument(); restoreImage()}
})
