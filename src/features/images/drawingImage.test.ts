import { expect, test } from 'bun:test'
import { DRAWING_IMAGE_EDGE, optimizeDrawingImage } from './drawingImage'
import { inspectImage } from './format'
import { MAX_IMAGE_INTENT_BYTES } from './transport'
import { MAX_IMAGE_BYTES, imageDataURL } from './types'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))

function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
}

function rasterHarness({ width = 3000, height = 1500, encode }: {
  width?: number; height?: number
  encode: (width: number, height: number, quality?: number) => Blob | null
}) {
  let closed = 0
  const draws: Array<{ width: number; height: number; quality: string }> = []
  const context = {
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    drawImage: () => { draws.push({ width: canvas.width, height: canvas.height, quality: context.imageSmoothingQuality }) },
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    toBlob: (callback: (blob: Blob | null) => void, type: string, quality?: number) => {
      expect(type).toBe('image/webp')
      callback(encode(canvas.width, canvas.height, quality))
    },
  }
  const restoreBitmap = replaceGlobal('createImageBitmap', async (_blob: Blob, options: ImageBitmapOptions) => {
    expect(options.imageOrientation).toBe('from-image')
    return { width, height, close: () => { closed++ } }
  })
  const restoreDocument = replaceGlobal('document', { createElement: (tag: string) => { expect(tag).toBe('canvas'); return canvas } })
  return { canvas, draws, closed: () => closed, restore: () => { restoreDocument(); restoreBitmap() } }
}

test('already small static bytes remain exact after their decoder succeeds', async () => {
  let closed = 0
  const restoreBitmap = replaceGlobal('createImageBitmap', async () => ({ width: 1, height: 1, close: () => { closed++ } }))
  const restoreDocument = replaceGlobal('document', { createElement: () => { throw new Error('No resize needed') } })
  try {
    expect(await optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 1024)).toEqual({
      dataURL: imageDataURL(png, 'image/png'), mimeType: 'image/png', width: 1, height: 1,
    })
    expect(closed).toBe(1)
  } finally { restoreDocument(); restoreBitmap() }
})

test('resizing retains aspect ratio, uses high quality smoothing and reduces dimensions until the byte budget fits', async () => {
  const qualities: number[] = []
  const harness = rasterHarness({
    encode: (width, _height, quality) => {
      qualities.push(quality!)
      return new Blob([new Uint8Array(width === DRAWING_IMAGE_EDGE ? 200 : 90)], { type: 'image/webp' })
    },
  })
  try {
    const result = await optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 100)
    expect(result.width).toBe(1200)
    expect(result.height).toBe(600)
    expect(result.mimeType).toBe('image/webp')
    expect(atob(result.dataURL.split(',')[1])).toHaveLength(90)
    expect(qualities).toEqual([0.82, 0.62, 0.82])
    expect(harness.draws).toEqual([{ width: 1600, height: 800, quality: 'high' }, { width: 1200, height: 600, quality: 'high' }])
    expect(harness.closed()).toBe(1)
    expect(harness.canvas.width).toBe(0)
    expect(harness.canvas.height).toBe(0)
  } finally { harness.restore() }
})

test('a browser falling back to PNG is labelled accurately and keeps a portrait image within the edge bound', async () => {
  const harness = rasterHarness({ width: 500, height: 3000, encode: () => new Blob([png], { type: 'image/png' }) })
  try {
    const result = await optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 1024)
    expect(result).toEqual({ dataURL: imageDataURL(png, 'image/png'), mimeType: 'image/png', width: 267, height: 1600 })
    expect(harness.closed()).toBe(1)
  } finally { harness.restore() }
})

test('drawing inputs above 5 MiB can be reduced while stored image validation keeps its default bound', async () => {
  // Add an ancillary PNG chunk before IEND; header inspection does not decode its pixels.
  const extra = new Uint8Array(MAX_IMAGE_BYTES + 12)
  new DataView(extra.buffer).setUint32(0, extra.length - 12)
  extra.set(new TextEncoder().encode('tEXt'), 4)
  const large = new Uint8Array(png.length + extra.length)
  large.set(png.subarray(0, png.length - 12))
  large.set(extra, png.length - 12)
  large.set(png.subarray(png.length - 12), large.length - 12)
  expect(() => inspectImage(large, 'image/png')).toThrow('5 MiB')
  const harness = rasterHarness({ width: 1, height: 1, encode: () => new Blob([png], { type: 'image/png' }) })
  try {
    expect((await optimizeDrawingImage(new Blob([large], { type: 'image/png' }), 1024)).dataURL).toBe(imageDataURL(png, 'image/png'))
    expect(harness.closed()).toBe(1)
  } finally { harness.restore() }
})

test('invalid byte budgets, source limits and canceled input fail before reading or decoding', async () => {
  let reads = 0
  const blob = (size: number) => ({ size, arrayBuffer: async () => { reads++; return png.buffer } }) as Blob
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) await expect(optimizeDrawingImage(blob(1), maxBytes)).rejects.toThrow('no room')
  for (const size of [0, MAX_IMAGE_INTENT_BYTES + 1]) await expect(optimizeDrawingImage(blob(size), 100)).rejects.toThrow('20 MiB')
  const controller = new AbortController()
  controller.abort()
  await expect(optimizeDrawingImage(blob(1), 100, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(reads).toBe(0)
})

test('a pixel bomb is refused by header validation before allocating a decoder', async () => {
  let decodes = 0
  const oversized = png.slice()
  new DataView(oversized.buffer).setUint32(16, 10_000)
  new DataView(oversized.buffer).setUint32(20, 10_000)
  const restoreBitmap = replaceGlobal('createImageBitmap', () => { decodes++; throw new Error('Unexpected decode') })
  try {
    await expect(optimizeDrawingImage(new Blob([oversized], { type: 'image/png' }), 100)).rejects.toThrow('8 million pixels')
    expect(decodes).toBe(0)
  } finally { restoreBitmap() }
})

test('a decoder failure refuses even an otherwise small image', async () => {
  const failure = new Error('Corrupt image data')
  const restoreBitmap = replaceGlobal('createImageBitmap', async () => { throw failure })
  try {
    await expect(optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 1024)).rejects.toBe(failure)
  } finally { restoreBitmap() }
})

test('canceling an encode closes the bitmap and releases the canvas', async () => {
  const controller = new AbortController()
  const harness = rasterHarness({ encode: () => { controller.abort(); return new Blob([png], { type: 'image/png' }) } })
  try {
    await expect(optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 1024, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(harness.closed()).toBe(1)
    expect(harness.canvas.width).toBe(0)
  } finally { harness.restore() }
})

test('an encoder that cannot fit any image stops at one pixel and still releases resources', async () => {
  const harness = rasterHarness({ encode: () => null })
  try {
    await expect(optimizeDrawingImage(new Blob([png], { type: 'image/png' }), 100)).rejects.toThrow('small enough')
    expect(harness.draws.at(-1)).toEqual({ width: 1, height: 1, quality: 'high' })
    expect(harness.draws.length).toBeLessThan(30)
    expect(harness.closed()).toBe(1)
  } finally { harness.restore() }
})

test('a failed SVG decode revokes its object URL', async () => {
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const revoked: string[] = []
  const failure = new Error('Invalid SVG image')
  const restoreImage = replaceGlobal('Image', class { src = ''; async decode() { throw failure } })
  URL.createObjectURL = () => 'blob:drawing-image-test'
  URL.revokeObjectURL = url => { revoked.push(url) }
  try {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>'], { type: 'image/svg+xml' })
    await expect(optimizeDrawingImage(svg, 1024)).rejects.toBe(failure)
    expect(revoked).toEqual(['blob:drawing-image-test'])
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; restoreImage() }
})
