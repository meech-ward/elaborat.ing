import { describe, expect, test } from 'bun:test'
import { FULL_PREVIEW_REGION, MAX_PREVIEW_FILE_BYTES, parsePreviewJob, parsePreviewReply, type PreviewRenderJob, type PreviewRenderReply } from './protocol.ts'

const job = (): PreviewRenderJob => ({
  job_id: crypto.randomUUID(), input_digest: 'a'.repeat(64), renderer_build: '12345678', profile: 'light-v1',
  kind: 'drawing', path: 'drawing.excalidraw', source: '{}', canvas: null, layout: null, region: null,
})

describe('preview boundary', () => {
  test('rejects escaping, nonfinite and empty normalized viewports', () => {
    for (const region of [
      { x: .5, y: 0, width: .6, height: 1 }, { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: Infinity, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    ]) expect(() => parsePreviewJob({ ...job(), region })).toThrow()
  })

  test('checks UTF-8 bytes and refuses caller rendering options', () => {
    expect(() => parsePreviewJob({ ...job(), source: '界'.repeat(Math.floor(MAX_PREVIEW_FILE_BYTES / 2)) })).toThrow()
    expect(() => parsePreviewJob({ ...job(), url: 'https://example.com' })).toThrow()
    expect(() => parsePreviewJob({ ...job(), kind: 'diagram', source: 'a'.repeat(65 * 1024) })).toThrow()
  })

  test('binds replies to the complete job and viewport', () => {
    const input = job()
    const reply: PreviewRenderReply = { png: 'AAAA', outcome: {
      job_id: input.job_id, input_digest: input.input_digest, renderer_build: input.renderer_build,
      status: 'ready', profile: 'light-v1', rendered_from: 'saved_scene', regenerated: false,
      view_box: [0, 0, 100, 100], region: FULL_PREVIEW_REGION, pixel_width: 100, pixel_height: 100, scale: 1, diagnostics: [],
    } }
    expect(parsePreviewReply(reply, input)).toEqual(reply)
    expect(() => parsePreviewReply(reply, { ...input, input_digest: 'b'.repeat(64) })).toThrow()
    expect(() => parsePreviewReply(reply, { ...input, region: { x: 0, y: 0, width: .5, height: .5 } })).toThrow()
    expect(() => parsePreviewReply({ ...reply, outcome: { ...reply.outcome, pixel_width: 1600, pixel_height: 1600 } }, input)).toThrow()
  })
})
