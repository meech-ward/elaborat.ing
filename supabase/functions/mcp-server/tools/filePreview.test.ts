import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import {
  FULL_PREVIEW_REGION,
  MAX_PREVIEW_BASE64_CHARS,
  type PreviewRenderer,
  type PreviewRenderJob,
  type PreviewRenderReply,
} from '../../../../src/agent-preview/protocol.ts'
import { filePreviewPayload, registerFilePreview } from './filePreview.ts'
import type { ToolContext } from './types.ts'

const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001'
const ROOT = 'bbbbbbbb-0000-4000-8000-000000000001'
// A real 1x1 RGBA PNG, decoded again by Photon in the payload.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg=='
type Row = { id: string; path: string; kind: 'text' | 'image'; content: string; version: number }
const drawing = (path = 'art/a.excalidraw', content = '{"elements":[]}'): Row => ({ id: ROOT, path, kind: 'text', content, version: 4 })

function fake(initial = [drawing()]) {
  const queries: Array<{ table: string; columns?: string; filters: Record<string, unknown> }> = []
  const state = { rows: initial, readable: true, error: null as unknown }
  const supabase = {
    from(table: string) {
      const query = { table, columns: undefined as string | undefined, filters: {} as Record<string, unknown> }
      queries.push(query)
      const builder = {
        select: (columns: string) => (query.columns = columns, builder),
        eq: (key: string, value: unknown) => (query.filters[key] = value, builder),
        in: (key: string, value: unknown) => (query.filters[key] = value, builder),
        abortSignal: (_signal: AbortSignal) => builder,
        maybeSingle: async () => ({
          data: state.readable ? state.rows.find(row => row.id === query.filters.id) ?? null : null,
          error: state.error,
        }),
        then(resolve: (value: unknown) => void) {
          const paths = query.filters.path as string[]
          resolve({ data: state.readable ? state.rows.filter(row => paths.includes(row.path)).map(row => ({ ...row })) : [], error: state.error })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
  return { context: { supabase } as ToolContext, state, queries }
}

function ready(job: PreviewRenderJob): PreviewRenderReply {
  return {
    png: PNG,
    outcome: {
      job_id: job.job_id,
      input_digest: job.input_digest,
      renderer_build: job.renderer_build,
      status: 'ready',
      profile: job.profile,
      rendered_from: job.kind === 'drawing' ? 'saved_scene' : 'projected_diagram',
      regenerated: job.kind === 'diagram',
      view_box: [-10, -20, 100, 50],
      region: job.region ?? FULL_PREVIEW_REGION,
      pixel_width: 1,
      pixel_height: 1,
      scale: 0.01,
      diagnostics: [],
    },
  }
}
const metadata = (result: CallToolResult) => result.structuredContent as Record<string, unknown>
const errorCode = (result: CallToolResult) => metadata(result).code
const imageCount = (result: CallToolResult) => result.content.filter(item => item.type === 'image').length

async function withClient<T>(context: ToolContext, renderer: PreviewRenderer, run: (client: Client) => Promise<T>) {
  const server = new McpServer({ name: 'preview-test', version: '1' })
  registerFilePreview(server, context, renderer)
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  try { return await run(client) }
  finally { await client.close(); await server.close() }
}

Deno.test('a real MCP client receives verified PNG pixels without an app resource or duplicated image data', async () => {
  const f = fake(), jobs: PreviewRenderJob[] = []
  await withClient(f.context, async job => (jobs.push(job), ready(job)), async client => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'get_file_preview')!
    assertEquals(tool.annotations, { title: 'Inspect drawing', readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assertEquals(tool._meta, undefined)
    const result = await client.callTool({ name: 'get_file_preview', arguments: { project_id: PROJECT, path: 'art/a.excalidraw', expected_version: 4 } }) as CallToolResult
    assertEquals(result.isError, undefined)
    assertEquals(result.content.filter(item => item.type === 'image'), [{ type: 'image', data: PNG, mimeType: 'image/png' }])
    assertEquals(result._meta, undefined)
    assertEquals(JSON.stringify(result.structuredContent).includes(PNG), false)
    assertEquals(metadata(result).version, 4)
    assertEquals(jobs.length, 1)
    assertEquals(jobs[0].canvas, null)
    assertEquals(Object.keys(jobs[0]).includes('project_id'), false)
    assertEquals(f.queries.length, 2)
    assertEquals(f.queries[0], { table: 'project_files', columns: 'id,path,kind,content,version', filters: { project_id: PROJECT, path: ['art/a.excalidraw'] } })
    assertEquals(f.queries[1].filters, { project_id: PROJECT, id: ROOT })
  })
})

Deno.test('D2 source, canvas and sidecar are frozen in one statement with exact identities and explicit missing companions', async () => {
  const root = drawing('art/a.d2', 'a -> b')
  const canvas = { ...drawing('art/a.excalidraw', 'saved canvas'), id: 'cccccccc-0000-4000-8000-000000000001', version: 3 }
  const f = fake([root, canvas]), jobs: PreviewRenderJob[] = []
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: root.path }, async job => (jobs.push(job), ready(job)))
  assertEquals(result.isError, undefined)
  assertEquals(f.queries[0].filters.path, ['art/a.d2', 'art/a.excalidraw', 'art/a.d2.json'])
  assertEquals(jobs[0].source, 'a -> b')
  assertEquals(jobs[0].canvas, 'saved canvas')
  assertEquals(jobs[0].layout, null)
  const inputs = metadata(result).inputs as Array<Record<string, unknown>>
  assertEquals(inputs.map(input => [input.path, input.id, input.version]), [[root.path, ROOT, 4], [canvas.path, canvas.id, 3], ['art/a.d2.json', null, null]])
  assertEquals(inputs[2].sha256, null)
  assertEquals(typeof inputs[0].sha256, 'string')
})

Deno.test('native and Obsidian drawings use the saved source without generated saves', async () => {
  for (const path of ['art/a.excalidraw', 'art/a.excalidraw.md']) {
    const source = path.endsWith('.md') ? '## Drawing\n```compressed-json\nopaque saved bytes\n```' : '{"elements":[],"files":{}}'
    const f = fake([drawing(path, source)])
    const result = await filePreviewPayload(f.context, { project_id: PROJECT, path }, async job => {
      assertEquals(job.source, source)
      return ready(job)
    })
    assertEquals(result.isError, undefined)
    assert(f.queries.every(query => query.table === 'project_files'))
  }
})

Deno.test('version, snapshot and unsupported-file failures do not invoke the renderer', async () => {
  const f = fake()
  let renders = 0
  const renderer: PreviewRenderer = async job => (renders++, ready(job))
  assertEquals(errorCode(await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw', expected_version: 3 }, renderer)), 'conflict')
  assertEquals(errorCode(await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw', expected_snapshot: 'a'.repeat(64) }, renderer)), 'conflict')
  assertEquals(errorCode(await filePreviewPayload(f.context, { project_id: PROJECT, path: 'notes/a.mdx' }, renderer)), 'unsupported')
  assertEquals(renders, 0)
})

Deno.test('a detail crop is pinned to every companion and missing-input state, not only the root version', async () => {
  const root = drawing('art/a.d2', 'a -> b')
  const f = fake([root]), region = { x: 0.2, y: 0.1, width: 0.4, height: 0.5 }
  let renders = 0
  const renderer: PreviewRenderer = async job => (renders++, ready(job))
  const overview = await filePreviewPayload(f.context, { project_id: PROJECT, path: root.path }, renderer)
  const snapshot = metadata(overview).snapshot as string
  const crop = await filePreviewPayload(f.context, { project_id: PROJECT, path: root.path, expected_snapshot: snapshot, region }, renderer)
  assertEquals(crop.isError, undefined)
  assertEquals(metadata(crop).region, region)
  assertEquals(metadata(crop).snapshot, snapshot)
  f.state.rows.push({ ...drawing('art/a.excalidraw', 'new companion'), id: 'cccccccc-0000-4000-8000-000000000001', version: 5 })
  const conflict = await filePreviewPayload(f.context, { project_id: PROJECT, path: root.path, expected_version: 4, expected_snapshot: snapshot, region }, renderer)
  assertEquals(errorCode(conflict), 'conflict')
  assertEquals(renders, 2)
})

Deno.test('invalid and unpinned regions are refused before any database or renderer work', async () => {
  const f = fake()
  await withClient(f.context, async job => ready(job), async client => {
    for (const args of [
      { region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { expected_snapshot: 'a'.repeat(64), region: { x: 0.8, y: 0, width: 0.5, height: 0.5 } },
      { expected_snapshot: 'a'.repeat(64), region: { x: 0, y: 0, width: 0, height: 0.5 } },
      { path: '../a.excalidraw' },
    ]) {
      const result = await client.callTool({ name: 'get_file_preview', arguments: { project_id: PROJECT, path: 'art/a.excalidraw', ...args } })
      assertEquals(result.isError, true)
    }
    assertEquals(f.queries.length, 0)
  })
})

Deno.test('missing, inaccessible and image-kind roots do not spend renderer work', async () => {
  let renders = 0
  for (const f of [fake([]), fake([{ ...drawing(), kind: 'image' }])]) {
    const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async job => (renders++, ready(job)))
    assertEquals(result.isError, true)
    assertEquals(imageCount(result), 0)
  }
  assertEquals(renders, 0)
})

Deno.test('permission loss or root replacement during rendering withholds the completed image', async () => {
  for (const mode of ['revoke', 'replace']) {
    const f = fake()
    const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async job => {
      if (mode === 'revoke') f.state.readable = false
      else f.state.rows[0].id = 'cccccccc-0000-4000-8000-000000000001'
      return ready(job)
    })
    assertEquals(errorCode(result), 'missing')
    assertEquals(imageCount(result), 0)
  }
})

Deno.test('a concurrent save reports the exact frozen version instead of relabeling its old pixels', async () => {
  const f = fake()
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async job => {
    f.state.rows[0].version = 5
    f.state.rows[0].content = 'new saved bytes'
    return ready(job)
  })
  assertEquals(result.isError, undefined)
  assertEquals(metadata(result).version, 4)
  assertEquals((metadata(result).inputs as Array<{ version: number }>)[0].version, 4)
})

Deno.test('malformed, wrong-job, wrong-region, oversized and corrupt renderer images return no pixels', async () => {
  const mutations: Array<(reply: PreviewRenderReply) => void> = [
    reply => { reply.outcome.job_id = 'cccccccc-0000-4000-8000-000000000001' },
    reply => { if (reply.outcome.status === 'ready') reply.outcome.region = { x: 0, y: 0, width: 0.5, height: 1 } },
    reply => { if ('png' in reply) reply.png = 'a'.repeat(MAX_PREVIEW_BASE64_CHARS + 1) },
    reply => { if ('png' in reply) reply.png = btoa('corrupt') },
    reply => { if (reply.outcome.status === 'ready') reply.outcome.pixel_width = 2 },
  ]
  for (const mutate of mutations) {
    const f = fake()
    const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async job => {
      const reply = ready(job); mutate(reply); return reply
    })
    assertEquals(result.isError, true)
    assertEquals(imageCount(result), 0)
    assertEquals(f.queries.length, 1)
  }
})

Deno.test('a PNG with valid headers but corrupt compressed pixels is rejected by the decoder', async () => {
  const f = fake()
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async job => {
    const reply = ready(job)
    const bytes = Uint8Array.from(atob(PNG), char => char.charCodeAt(0))
    bytes[45] ^= 255
    if ('png' in reply) reply.png = btoa(String.fromCharCode(...bytes))
    return reply
  })
  assertEquals(errorCode(result), 'render_failed')
  assertEquals(imageCount(result), 0)
})

Deno.test('D2 and native renderer failures carry bounded diagnostics without a success image', async () => {
  const f = fake([drawing('art/a.d2', 'bad source')])
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.d2' }, async job => ({ outcome: {
    job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build,
    status: 'error', code: 'd2_error', message: 'The diagram source does not compile.',
    diagnostics: [{ code: 'source', message: 'art/a.d2:1: invalid statement' }],
  } }))
  assertEquals(errorCode(result), 'd2_error')
  assertEquals(imageCount(result), 0)
  assertEquals(f.queries.length, 2)
})

Deno.test('permission loss also withholds source-bearing render diagnostics', async () => {
  const f = fake([drawing('art/a.d2', 'private source')])
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.d2' }, async job => {
    f.state.readable = false
    return { outcome: {
      job_id: job.job_id, input_digest: job.input_digest, renderer_build: job.renderer_build,
      status: 'error', code: 'd2_error', message: 'private source failure',
      diagnostics: [{ code: 'source', message: 'private source' }],
    } }
  })
  assertEquals(errorCode(result), 'missing')
  assertEquals(JSON.stringify(result).includes('private source'), false)
})

Deno.test('caller cancellation interrupts an injected renderer that does not observe its abort signal', async () => {
  const f = fake(), controller = new AbortController()
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, async () => {
    controller.abort()
    return await new Promise<PreviewRenderReply>(() => {})
  }, controller.signal)
  assertEquals(errorCode(result), 'cancelled')
  assertEquals(imageCount(result), 0)
})

async function withWorker<T>(fetcher: typeof fetch, run: () => Promise<T>, secret?: string) {
  const oldFetch = globalThis.fetch
  const oldSecret = Deno.env.get('AGENT_PREVIEW_SECRET'), oldEndpoint = Deno.env.get('AGENT_PREVIEW_ENDPOINT')
  globalThis.fetch = fetcher
  if (secret) Deno.env.set('AGENT_PREVIEW_SECRET', secret)
  else Deno.env.delete('AGENT_PREVIEW_SECRET')
  Deno.env.set('AGENT_PREVIEW_ENDPOINT', 'https://preview.example/_agent-preview')
  try { return await run() }
  finally {
    globalThis.fetch = oldFetch
    if (oldSecret === undefined) Deno.env.delete('AGENT_PREVIEW_SECRET'); else Deno.env.set('AGENT_PREVIEW_SECRET', oldSecret)
    if (oldEndpoint === undefined) Deno.env.delete('AGENT_PREVIEW_ENDPOINT'); else Deno.env.set('AGENT_PREVIEW_ENDPOINT', oldEndpoint)
  }
}

Deno.test('the default adapter is safely unavailable until configured and sends no request', async () => {
  let fetched = false
  await withWorker((() => { fetched = true; throw new Error('unexpected') }) as typeof fetch, async () => {
    const f = fake(), result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' })
    assertEquals(errorCode(result), 'unavailable')
    assertEquals(fetched, false)
  })
})

Deno.test('the default adapter posts only the authorized render job and its separate service secret', async () => {
  const secret = 'test-only-preview-secret'
  await withWorker((async (url, init) => {
    assertEquals(String(url), 'https://preview.example/_agent-preview')
    assertEquals(init?.redirect, 'error')
    assertEquals(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
    const job = JSON.parse(String(init?.body)) as PreviewRenderJob
    assertEquals(Object.keys(job).includes('supabase'), false)
    assertEquals(Object.keys(job).includes('project_id'), false)
    assertEquals(String(init?.body).includes(secret), false)
    return Response.json(ready(job))
  }) as typeof fetch, async () => {
    const f = fake(), result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' })
    assertEquals(result.isError, undefined)
    assertEquals(JSON.stringify(result).includes(secret), false)
  }, secret)
})

Deno.test('rate limits preserve retry timing and raw provider errors never reach the model', async () => {
  for (const status of [429, 401, 500]) {
    await withWorker((async () => new Response('sensitive provider debug detail', { status, headers: { 'retry-after': '12' } })) as typeof fetch, async () => {
      const f = fake(), result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' })
      assertEquals(errorCode(result), status === 429 ? 'rate_limit' : 'unavailable')
      if (status === 429) assertEquals(metadata(result).retry_after, 12)
      assertEquals(JSON.stringify(result).includes('sensitive'), false)
      assertEquals(imageCount(result), 0)
    }, 'test-secret')
  }
})

Deno.test('oversized provider replies are stopped before parsing or returning image content', async () => {
  await withWorker((async () => new Response('x'.repeat(MAX_PREVIEW_BASE64_CHARS + 20_000))) as typeof fetch, async () => {
    const f = fake(), result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' })
    assertEquals(errorCode(result), 'limit')
    assertEquals(imageCount(result), 0)
  }, 'test-secret')
})

Deno.test('unexpected database and renderer exceptions are replaced with safe actionable errors', async () => {
  const f = fake()
  const result = await filePreviewPayload(f.context, { project_id: PROJECT, path: 'art/a.excalidraw' }, () => { throw new Error('bearer secret private-stack') })
  assertEquals(result.isError, true)
  assertEquals(JSON.stringify(result).includes('private-stack'), false)
  assertStringIncludes(JSON.stringify(result), 'https://elaborat.ing/projects/')
})
