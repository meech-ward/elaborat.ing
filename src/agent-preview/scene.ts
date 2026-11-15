import { parseDrawingFile, DRAWING_FENCE_RE } from '../features/drawings/parse'
import type { DrawingScene } from '../features/drawings/types'
import { MAX_PREVIEW_FILE_BYTES } from './protocol'
import { decompressDrawingBase64, DrawingDecompressionLimitError } from './boundedLz'

export const MAX_PREVIEW_ELEMENTS = 3000
export const MAX_PREVIEW_POINTS = 100_000
export const MAX_PREVIEW_TEXT = 200_000
export const MAX_PREVIEW_SVG_CHARS = 8 * 1024 * 1024
const supportedTypes = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'])
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

export class PreviewFailure extends Error {
  constructor(readonly code: 'invalid_input' | 'unsupported' | 'empty' | 'limit' | 'render_failed' | 'd2_error', message: string) { super(message) }
}

/** Bound arbitrary JSON before native restoration, sidecar parsing or D2 merging. */
export function checkPreviewValue(value: unknown): void {
  const pending = [{ value, depth: 0 }]
  let nodes = 0, characters = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 300_000 || item.depth > 48) throw new PreviewFailure('limit', 'The drawing is too deeply nested or complex.')
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new PreviewFailure('limit', 'The drawing has non-finite numeric data.')
    if (typeof item.value === 'string') {
      characters += item.value.length
      if (characters > MAX_PREVIEW_FILE_BYTES * 2) throw new PreviewFailure('limit', 'The drawing contains too much text or image data.')
    } else if (item.value && typeof item.value === 'object') {
      for (const key in item.value) {
        if (!Object.hasOwn(item.value, key)) continue
        if (unsafeKeys.has(key)) throw new PreviewFailure('invalid_input', 'The drawing contains an unsafe object key.')
        if (nodes + pending.length >= 300_000) throw new PreviewFailure('limit', 'The drawing is too deeply nested or complex.')
        pending.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 })
      }
    }
  }
}

/** Never enter parseDrawingFile's unbounded legacy decompression path. */
export function parsePreviewScene(source: string, path: string): DrawingScene {
  if (source.length > MAX_PREVIEW_FILE_BYTES || new TextEncoder().encode(source).length > MAX_PREVIEW_FILE_BYTES) throw new PreviewFailure('limit', 'The drawing source exceeds 2 MiB.')
  const trimmed = source.trim()
  let json = trimmed
  if (!trimmed.startsWith('{')) {
    const fence = DRAWING_FENCE_RE.exec(trimmed)
    if (!fence) throw new PreviewFailure('invalid_input', 'The file has no supported drawing payload.')
    if (fence[1] === 'compressed-json') {
      try { json = decompressDrawingBase64(fence[2], MAX_PREVIEW_FILE_BYTES) }
      catch (error) { throw new PreviewFailure(error instanceof DrawingDecompressionLimitError ? 'limit' : 'invalid_input', error instanceof Error ? error.message : 'The compressed drawing is invalid.') }
    } else json = fence[2]
  }
  if (json.length > MAX_PREVIEW_FILE_BYTES || new TextEncoder().encode(json).length > MAX_PREVIEW_FILE_BYTES) throw new PreviewFailure('limit', 'The expanded drawing exceeds 2 MiB.')
  let raw: unknown
  try { raw = JSON.parse(json) } catch { throw new PreviewFailure('invalid_input', 'The drawing payload is not valid JSON.') }
  checkPreviewValue(raw)
  let scene: DrawingScene
  try { scene = parseDrawingFile(json, path).scene }
  catch { throw new PreviewFailure('invalid_input', 'The saved drawing scene is invalid.') }
  validatePreviewScene(scene)
  return scene
}

/** Unknown types fail explicitly instead of disappearing from a native export. */
export function validatePreviewScene(scene: DrawingScene): void {
  checkPreviewValue(scene)
  if (scene.elements.length > MAX_PREVIEW_ELEMENTS) throw new PreviewFailure('limit', 'The drawing exceeds 3,000 elements.')
  let points = 0, text = 0, hatchCost = 0, frameTextCost = 0
  const ids = new Set<string>()
  for (const element of scene.elements) {
    if (element.isDeleted === true) continue
    if (element.id.length > 512) throw new PreviewFailure('limit', 'A drawing element ID is too long.')
    if (ids.has(element.id)) throw new PreviewFailure('invalid_input', 'The drawing contains duplicate element IDs.')
    ids.add(element.id)
    if (!supportedTypes.has(element.type)) throw new PreviewFailure('unsupported', `Drawing element type ${element.type.slice(0, 80)} is not supported.`)
    if (Array.isArray(element.points)) points += element.points.length
    text += Math.max(typeof element.text === 'string' ? element.text.length : 0, typeof element.originalText === 'string' ? element.originalText.length : 0)
    if (typeof element.name === 'string') {
      text += element.name.length
      if (element.type === 'frame' || element.type === 'magicframe') frameTextCost += element.name.length ** 2
    }
    if (frameTextCost > 1_000_000) throw new PreviewFailure('limit', 'The drawing exceeds the frame-caption measurement budget.')
    if (points > MAX_PREVIEW_POINTS || text > MAX_PREVIEW_TEXT) throw new PreviewFailure('limit', 'The drawing exceeds the point or text budget.')
    for (const key of ['x', 'y', 'width', 'height', 'angle', 'strokeWidth', 'fontSize', 'fontFamily', 'roughness', 'opacity', 'seed', 'lineHeight']) {
      if (element[key] !== undefined && (typeof element[key] !== 'number' || !Number.isFinite(element[key]))) throw new PreviewFailure('invalid_input', 'The drawing has a nonnumeric geometry or style field.')
    }
    if (Array.isArray(element.pressures) && element.pressures.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new PreviewFailure('invalid_input', 'The drawing has invalid freehand pressure data.')
    const number = (key: string, fallback: number) => typeof element[key] === 'number' ? element[key] as number : fallback
    for (const key of ['x', 'y', 'width', 'height', 'angle']) if (Math.abs(number(key, 0)) > 10_000_000) throw new PreviewFailure('limit', 'The drawing has unsupported numeric geometry.')
    if (Array.isArray(element.points) && element.points.some(point => !Array.isArray(point) || point.length < 2 || point.slice(0, 2).some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > 10_000_000))) throw new PreviewFailure('invalid_input', 'The drawing contains invalid point geometry.')
    const stroke = number('strokeWidth', 2), width = Math.abs(number('width', 0)), height = Math.abs(number('height', 0))
    if (stroke < 0 || stroke > 1000 || number('fontSize', 20) <= 0 || number('fontSize', 20) > 1000 || number('roughness', 1) < 0 || number('roughness', 1) > 3 || number('opacity', 100) < 0 || number('opacity', 100) > 100 || number('lineHeight', 1.25) <= 0 || number('lineHeight', 1.25) > 10) throw new PreviewFailure('limit', 'The drawing has an unsupported stroke, text style or opacity.')
    if (element.backgroundColor && element.backgroundColor !== 'transparent' && element.fillStyle !== 'solid') {
      let fillWidth = width, fillHeight = height
      if (Array.isArray(element.points) && element.points.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const point of element.points as number[][]) { minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]); maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]) }
        fillWidth = Math.max(fillWidth, maxX - minX)
        fillHeight = Math.max(fillHeight, maxY - minY)
      }
      const gap = stroke * 4
      if (gap <= 0) throw new PreviewFailure('limit', 'The drawing exceeds the patterned-fill complexity budget.')
      hatchCost += element.fillStyle === 'dots' ? fillWidth * fillHeight / (gap * gap) * 8 : (fillWidth + fillHeight) / gap * 4
      if (hatchCost > 30_000) throw new PreviewFailure('limit', 'The drawing exceeds the patterned-fill complexity budget.')
    }
    if (element.type === 'image') {
      if (typeof element.fileId !== 'string' || !element.fileId || width < 1 || height < 1) throw new PreviewFailure('invalid_input', 'A drawing image has no valid file reference or dimensions.')
      if (element.scale !== undefined && (!Array.isArray(element.scale) || element.scale.length !== 2 || element.scale.some(value => value !== -1 && value !== 1))) throw new PreviewFailure('invalid_input', 'The drawing image scale is invalid.')
      const crop = element.crop
      if (crop != null) {
        if (typeof crop !== 'object' || Array.isArray(crop)) throw new PreviewFailure('invalid_input', 'The image crop is invalid.')
        const values = crop as Record<string, unknown>
        if (!['x', 'y', 'width', 'height', 'naturalWidth', 'naturalHeight'].every(key => typeof values[key] === 'number' && Number.isFinite(values[key]))) throw new PreviewFailure('invalid_input', 'The image crop is invalid.')
        const c = values as Record<string, number>
        if (c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.naturalWidth <= 0 || c.naturalHeight <= 0 || c.x + c.width > c.naturalWidth || c.y + c.height > c.naturalHeight) throw new PreviewFailure('invalid_input', 'The image crop is outside its original image.')
      }
    }
  }
  if (!ids.size) throw new PreviewFailure('empty', 'The drawing has no active elements.')
}
