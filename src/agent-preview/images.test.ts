import { expect, test } from 'bun:test'
import type { DrawingScene } from '../features/drawings/types'
import { imageDataURL } from '../features/images/types'
import { inspectSceneImages, prepareSceneImages } from './images'

const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), value => value.charCodeAt(0))
const image = (id: string) => ({ id, type: 'image', x: 0, y: 0, width: 100, height: 100, fileId: id })
const file = (id: string, bytes = pixel) => ({ id, mimeType: 'image/png', created: 1757200000, dataURL: imageDataURL(bytes, 'image/png') })
const scene = (ids = ['a']): DrawingScene => ({ type: 'excalidraw', version: 2, elements: ids.map(image), files: Object.fromEntries(ids.map(id => [id, file(id)])) })

test('only active referenced images enter the native table with safe copied IDs', async () => {
  const input = scene(['id:with[punctuation]'])
  input.files!.unused = { ...file('unused'), dataURL: 'https://example.com/secret.png' }
  const before = JSON.stringify(input)
  const result = await prepareSceneImages(input, async (blob, width, height) => {
    expect(blob.type).toBe('image/png')
    expect([width, height]).toEqual([1, 1])
  })
  expect(Object.keys(result.scene.files!)).toEqual(['preview-image-0'])
  expect(result.scene.elements[0].fileId).toBe('preview-image-0')
  expect(result.scene.files!['preview-image-0'].dataURL).toBe(input.files!['id:with[punctuation]'].dataURL)
  expect(JSON.stringify(input)).toBe(before)
})

test('missing, network and oversized images are rejected before a decoder runs', () => {
  const missing = scene()
  missing.files = {}
  expect(() => inspectSceneImages(missing)).toThrow('missing')
  const network = scene()
  network.files!.a.dataURL = 'https://example.com/private.png'
  expect(() => inspectSceneImages(network)).toThrow('unsafe')
  const huge = new Uint8Array(pixel)
  new DataView(huge.buffer).setUint32(16, 100000)
  new DataView(huge.buffer).setUint32(20, 100000)
  const oversized = scene()
  oversized.files!.a = file('a', huge)
  expect(() => inspectSceneImages(oversized)).toThrow('pixels')
})

test('aggregate image pixels and unique image counts are bounded independently', () => {
  const many = scene(Array.from({ length: 33 }, (_, index) => String(index)))
  expect(() => inspectSceneImages(many)).toThrow('32 distinct')
  const bytes = new Uint8Array(pixel)
  new DataView(bytes.buffer).setUint32(16, 3000)
  new DataView(bytes.buffer).setUint32(20, 2000)
  const large = scene(['a', 'b', 'c', 'd', 'e'])
  for (const id of Object.keys(large.files!)) large.files![id] = file(id, bytes)
  expect(() => inspectSceneImages(large)).toThrow('24 million')
})
