import { expect, test } from 'bun:test'
import LZString from 'lz-string'
import demo from '../features/drawings/fixtures/demo.scene.json'
import { checkPreviewValue, parsePreviewScene, validatePreviewScene } from './scene'

const scene = (elements: unknown[]) => JSON.stringify({ type: 'excalidraw', version: 2, elements, files: {} })
const box = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }

test('plain, Obsidian JSON and bounded compressed drawings preserve the same scene', () => {
  const source = JSON.stringify(demo)
  const plain = parsePreviewScene(source, 'drawing.excalidraw')
  expect(parsePreviewScene(`before\n\`\`\`json\n${source}\n\`\`\`\nafter`, 'drawing.excalidraw.md')).toEqual(plain)
  expect(parsePreviewScene(`\`\`\`compressed-json\n${LZString.compressToBase64(source)}\n\`\`\``, 'drawing.excalidraw.md')).toEqual(plain)
  expect(plain.elements.some(element => element.isDeleted === true)).toBe(true)
})

test('unsupported live elements, duplicate IDs and non-finite geometry fail explicitly', () => {
  expect(() => parsePreviewScene(scene([{ ...box, type: 'future-element' }]), 'a.excalidraw')).toThrow('not supported')
  expect(() => parsePreviewScene(scene([box, box]), 'a.excalidraw')).toThrow('duplicate')
  expect(() => parsePreviewScene('{"elements":5}', 'a.excalidraw')).toThrow('scene is invalid')
  expect(() => parsePreviewScene(scene([{ ...box, width: 1e100 }]), 'a.excalidraw')).toThrow('geometry')
  expect(() => parsePreviewScene(scene([{ ...box, width: '1000000000000' }]), 'a.excalidraw')).toThrow('nonnumeric')
  expect(() => validatePreviewScene({ type: 'excalidraw', version: 2, elements: [{ ...box, x: Infinity }] })).toThrow('non-finite')
  expect(() => parsePreviewScene(scene([{ ...box, type: 'future-element', isDeleted: true }]), 'a.excalidraw')).toThrow('no active')
})

test('compressed expansion, deeply nested data and patterned-fill work are bounded', () => {
  const bomb = LZString.compressToBase64(scene([{ ...box, customData: 'x'.repeat(3 * 1024 * 1024) }]))
  expect(() => parsePreviewScene(`\`\`\`compressed-json\n${bomb}\n\`\`\``, 'a.excalidraw.md')).toThrow('limit')
  let nested: unknown = null
  for (let index = 0; index < 60; index++) nested = { nested }
  expect(() => checkPreviewValue(nested)).toThrow('nested')
  expect(() => parsePreviewScene(scene([{ ...box, width: 100000, height: 100000, backgroundColor: '#ffffff', fillStyle: 'dots' }]), 'a.excalidraw')).toThrow('complexity')
  expect(() => parsePreviewScene(scene([{ ...box, strokeWidth: 0.00001, backgroundColor: '#ffffff', fillStyle: 'hachure' }]), 'a.excalidraw')).toThrow('complexity')
  expect(() => parsePreviewScene(scene([{ ...box, type: 'frame', name: 'caption'.repeat(1000) }]), 'a.excalidraw')).toThrow('caption')
  expect(() => parsePreviewScene(scene([{ ...box, type: 'text', originalText: 'x'.repeat(200001) }]), 'a.excalidraw')).toThrow('text budget')
})

test('image crops and flips are checked before native export', () => {
  const image = { ...box, type: 'image', fileId: 'pic', scale: [1, -1], crop: { x: 0, y: 0, width: 50, height: 25, naturalWidth: 100, naturalHeight: 50 } }
  expect(parsePreviewScene(scene([image]), 'a.excalidraw').elements).toHaveLength(1)
  expect(() => parsePreviewScene(scene([{ ...image, scale: [1, 1000] }]), 'a.excalidraw')).toThrow('scale')
  expect(() => parsePreviewScene(scene([{ ...image, crop: { ...image.crop, x: 75 } }]), 'a.excalidraw')).toThrow('outside')
})

test('prototype-shaped payload keys are refused before native or sidecar parsing', () => {
  const malicious = `{"elements":[${JSON.stringify(box)}],"customData":{"__proto__":{"previewPolluted":true}}}`
  expect(() => parsePreviewScene(malicious, 'a.excalidraw')).toThrow('unsafe object key')
  expect(Object.hasOwn(Object.prototype, 'previewPolluted')).toBe(false)
})
