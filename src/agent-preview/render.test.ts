import { expect, test } from 'bun:test'
import { previewDimensions, previewViewport, renderAgentPreview } from './render'
import { MAX_PREVIEW_EDGE, MAX_PREVIEW_PIXELS, PREVIEW_PROFILE, type PreviewRenderJob } from './protocol'

test('normalized regions use the actual exported viewBox including native padding', () => {
  expect(previewViewport([0, 0, 770, 430], { x: 0.5, y: 0.25, width: 0.5, height: 0.5 })).toEqual({ x: 385, y: 107.5, width: 385, height: 215 })
  expect(previewViewport([-100, -200, 400, 600], { x: 0.25, y: 0.5, width: 0.5, height: 0.25 })).toEqual({ x: 0, y: 100, width: 200, height: 150 })
})

test('output dimensions bound both axes and total pixels for wide and thin scenes', () => {
  for (const [width, height] of [[1e7, 1e7], [1e7, 1], [1, 1e7], [400, 300], [0.1, 0.1]]) {
    const dimensions = previewDimensions(width, height)
    expect(dimensions.width).toBeGreaterThanOrEqual(1)
    expect(dimensions.height).toBeGreaterThanOrEqual(1)
    expect(dimensions.width).toBeLessThanOrEqual(MAX_PREVIEW_EDGE)
    expect(dimensions.height).toBeLessThanOrEqual(MAX_PREVIEW_EDGE)
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(MAX_PREVIEW_PIXELS)
  }
})

test('unsupported sources return a job-bound failure without loading a native browser renderer', async () => {
  const job: PreviewRenderJob = { job_id: '00000000-0000-4000-8000-000000000001', input_digest: 'a'.repeat(64), renderer_build: 'test-build', profile: PREVIEW_PROFILE,
    kind: 'drawing', path: 'a.excalidraw', source: JSON.stringify({ elements: [{ id: 'a', type: 'future-type', x: 0, y: 0 }] }), canvas: null, layout: null, region: null }
  const result = await renderAgentPreview(job)
  expect(result.outcome).toMatchObject({ status: 'error', code: 'unsupported', job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build })
  expect('png' in result).toBe(false)
})
