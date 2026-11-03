import {expect, test} from 'bun:test'
import {documentImage} from './documentImage'
import {MAX_IMAGE_BYTES, imageDataURL} from './types'

const decode = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))
const png = decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
const webp = decode('UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoDAAIAAUAmJaACdLoB+AAFIQAA/su3/9lY+lY+lY/eC/770BvAwAAA')
// A real 3 × 2 JPEG with EXIF orientation 6: displayed clockwise as 2 × 3.
const rotatedJpeg = decode('/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGiiivvDxD/9k=')
const animatedGif = decode('R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABAAgIACH5BAEKAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw==')
const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'], {type: 'image/svg+xml'})

/** Restore absent browser globals too, so these tests do not affect other files. */
function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value})
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
}

test('static raster bytes retain their detail and EXIF display dimensions without a bitmap or canvas', async () => {
  let allocations = 0
  const allocate = () => {allocations++; throw new Error('Static images must not be re-encoded')}
  const restoreBitmap = replaceGlobal('createImageBitmap', allocate)
  const restoreDocument = replaceGlobal('document', {createElement: allocate})
  try {
    for (const {bytes, mediaType, width, height} of [
      {bytes: png, mediaType: 'image/png' as const, width: 1, height: 1},
      {bytes: webp, mediaType: 'image/webp' as const, width: 3, height: 2},
      {bytes: rotatedJpeg, mediaType: 'image/jpeg' as const, width: 2, height: 3},
    ]) {
      expect(await documentImage(new Blob([bytes], {type: mediaType}))).toEqual({
        dataURL: imageDataURL(bytes, mediaType), width, height,
      })
    }
    expect(allocations).toBe(0)
  } finally {
    restoreDocument()
    restoreBitmap()
  }
})

test('empty and oversized images are refused before reading their buffers', async () => {
  let reads = 0
  for (const size of [0, MAX_IMAGE_BYTES + 1]) {
    const blob = {size, arrayBuffer: async () => {reads++; return new ArrayBuffer(0)}} as Blob
    await expect(documentImage(blob)).rejects.toThrow('document image limit')
  }
  expect(reads).toBe(0)
})

test('an already canceled image does not read its buffer', async () => {
  const controller = new AbortController()
  controller.abort()
  let reads = 0
  const blob = {size: png.length, arrayBuffer: async () => {reads++; return png.buffer}} as Blob
  await expect(documentImage(blob, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(reads).toBe(0)
})

test('canceling an animated decode closes its bitmap without allocating a canvas', async () => {
  const controller = new AbortController()
  let closed = 0
  let canvases = 0
  const restoreBitmap = replaceGlobal('createImageBitmap', async () => {
    controller.abort()
    return {width: 2, height: 1, close: () => {closed++}}
  })
  const restoreDocument = replaceGlobal('document', {createElement: () => {canvases++; throw new Error('Unexpected canvas')}})
  try {
    await expect(documentImage(new Blob([animatedGif], {type: 'image/gif'}), controller.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(closed).toBe(1)
    expect(canvases).toBe(0)
  } finally {
    restoreDocument()
    restoreBitmap()
  }
})

test('an unavailable raster canvas still releases the decoded animation bitmap', async () => {
  let closed = 0
  const restoreBitmap = replaceGlobal('createImageBitmap', async () => ({width: 2, height: 1, close: () => {closed++}}))
  const restoreDocument = replaceGlobal('document', {createElement: () => ({getContext: () => null})})
  try {
    await expect(documentImage(new Blob([animatedGif], {type: 'image/gif'}))).rejects.toThrow('could not be rendered')
    expect(closed).toBe(1)
  } finally {
    restoreDocument()
    restoreBitmap()
  }
})

test('a failed SVG decode revokes the temporary URL before returning the error', async () => {
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const urls: string[] = []
  const revoked: string[] = []
  const failure = new Error('Vector decode failed')
  const restoreImage = replaceGlobal('Image', class {
    src = ''
    async decode() {throw failure}
  })
  URL.createObjectURL = () => {const url = 'blob:document-image-test'; urls.push(url); return url}
  URL.revokeObjectURL = url => {revoked.push(url)}
  try {
    await expect(documentImage(svg)).rejects.toBe(failure)
    expect(urls).toHaveLength(1)
    expect(revoked).toEqual(urls)
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    restoreImage()
  }
})
