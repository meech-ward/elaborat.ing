import {expect, test} from 'bun:test'
import {drawingPngDimensions, exportDrawingPng} from './export'

test('PNG exports keep the default scale and constrain actual native bounds before canvas allocation', () => {
  expect(drawingPngDimensions(100.4, 60.7, 2)).toEqual({width: 201, height: 121, scale: 2})
  expect(drawingPngDimensions(100, 60, 2, 8_000_000)).toEqual({width: 200, height: 120, scale: 2})
  expect(drawingPngDimensions(100, 60, 2, 1500)).toEqual({width: 50, height: 30, scale: 0.5})
  for (const [width, height] of [[5000, 3000], [1e100, 1], [1, 1e100], [1e308, 1e308], [2828, 2829]]) {
    const output = drawingPngDimensions(width, height, 2, 8_000_000)
    expect(Number.isSafeInteger(output.width)).toBe(true)
    expect(Number.isSafeInteger(output.height)).toBe(true)
    expect(output.width).toBeGreaterThanOrEqual(1)
    expect(output.height).toBeGreaterThanOrEqual(1)
    expect(output.width * output.height).toBeLessThanOrEqual(8_000_000)
    expect(output.scale).toBeGreaterThan(0)
    expect(output.scale).toBeLessThanOrEqual(2)
  }
})

test('invalid PNG budgets fail before loading the native renderer', async () => {
  const scene = {type: 'excalidraw' as const, version: 2, elements: [{id: 'a', type: 'rectangle', x: 0, y: 0}]}
  for (const maxPixels of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(exportDrawingPng(scene, {maxPixels})).rejects.toThrow('pixel limit')
  for (const width of [0, -1, Infinity, NaN]) expect(() => drawingPngDimensions(width, 1, 2, 8_000_000)).toThrow('dimensions')
})
