import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { FULL_PREVIEW_REGION, MAX_PREVIEW_PNG_BYTES, PREVIEW_PROFILE } from '../../../../src/agent-preview/protocol.ts'
import { filePreviewPayload, registerFilePreview } from './filePreview.ts'
import type { ToolContext } from './types.ts'

const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001'
const ROOT = 'bbbbbbbb-0000-4000-8000-000000000001'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC'
const DIGEST = 'a'.repeat(64)
const BUILD = '7048a6cabb090b4b'
const bytes = Uint8Array.from(atob(PNG), character => character.charCodeAt(0))
const BYTEA = '\\x' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
function drawing(path = 'art/a.excalidraw') {
  return {
    id: ROOT, path, kind: 'text', version: 4,
    drawing_previews: {
      file_version: 4, generation: 2, status: 'ready', png: BYTEA, error_code: null, message: null,
      metadata: {
        snapshot: DIGEST,
        inputs: [{ path, id: ROOT, version: 4, sha256: 'b'.repeat(64) }],
        renderer_build: BUILD, profile: PREVIEW_PROFILE,
        outcome: {
          job_id: 'cccccccc-0000-4000-8000-000000000001', input_digest: DIGEST, renderer_build: BUILD,
          status: 'ready', profile: PREVIEW_PROFILE, rendered_from: path.endsWith('.d2') ? 'projected_diagram' : 'saved_scene',
          regenerated: path.endsWith('.d2'), view_box: [-10, -20, 100, 50], region: FULL_PREVIEW_REGION,
          pixel_width: 2, pixel_height: 2, scale: 0.02, diagnostics: [],
        },
      },
    },
  }
}
function fake(initial: unknown = drawing()) {
  const queries: Array<{ table: string; columns?: string; filters: Record<string, unknown> }> = []
  const state = { row: initial as ReturnType<typeof drawing> | null, readable: true, error: null as unknown, afterRead: null as (() => void) | null }
  const supabase = {
    from(table: string) {
      const query = { table, columns: undefined as string | undefined, filters: {} as Record<string, unknown> }
      queries.push(query)
      const builder = {
        select: (columns: string) => (query.columns = columns, builder),
        eq: (key: string, value: unknown) => (query.filters[key] = value, builder),
        abortSignal: (_signal: AbortSignal) => builder,
        maybeSingle: async () => {
          const matches = state.readable && state.row &&
            (query.filters.id === undefined || query.filters.id === state.row.id) &&
            (query.filters.path === undefined || query.filters.path === state.row.path)
          const data = matches ? structuredClone(query.columns === 'id' ? { id: state.row!.id } : state.row) : null
          if (query.columns !== 'id') state.afterRead?.()
          return { data, error: state.error }
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
  return { context: { supabase } as ToolContext, state, queries }
}
const meta = (result: CallToolResult) => result.structuredContent as Record<string, unknown>
const code = (result: CallToolResult) => meta(result).code
const images = (result: CallToolResult) => result.content.filter(item => item.type === 'image')
const input = { project_id: PROJECT, path: 'art/a.excalidraw' }
async function withClient<T>(context: ToolContext, run: (client: Client) => Promise<T>) {
  const server = new McpServer({ name: 'stored-preview-test', version: '1' })
  registerFilePreview(server, context)
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  try { return await run(client) }
  finally { await client.close(); await server.close() }
}

Deno.test('MCP returns stored PNG bytes without an app, source read, fetch or queue mutation', async () => {
  const f = fake(), original = globalThis.fetch
  globalThis.fetch = () => { throw new Error('A preview read must not fetch or render') }
  try {
    await withClient(f.context, async client => {
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'get_file_preview')!
      assertEquals(tool.annotations, { title: 'Inspect drawing', readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      assertEquals(tool._meta, undefined)
      assertStringIncludes(tool.description!, 'Reading never starts rendering')
      const result = await client.callTool({ name: 'get_file_preview', arguments: { ...input, expected_version: 4 } }) as CallToolResult
      assertEquals(result.isError, undefined)
      assertEquals(images(result), [{ type: 'image', data: PNG, mimeType: 'image/png' }])
      assertEquals(result._meta, undefined)
      assertEquals(JSON.stringify(result.structuredContent).includes(PNG), false)
      assertEquals(meta(result).stored, true)
      assertEquals(meta(result).snapshot, DIGEST)
      assertEquals(meta(result).version, 4)
      assertEquals(f.queries.length, 2)
      assert(f.queries.every(query => query.table === 'project_files'))
      assert(!f.queries[0].columns!.includes('content'))
    })
  } finally { globalThis.fetch = original }
})

Deno.test('repeated pending reads only return preparing and never wake rendering', async () => {
  for (const stored of [null, { ...drawing().drawing_previews, status: 'pending', png: null, metadata: null }]) {
    const root = drawing() as Record<string, unknown>
    root.drawing_previews = stored
    const f = fake(root)
    for (let n = 0; n < 3; n++) {
      const result = await filePreviewPayload(f.context, input)
      assertEquals(result.isError, undefined)
      assertEquals(meta(result).status, 'pending')
      assertEquals(meta(result).retry_after, 5)
      assertEquals(images(result), [])
    }
    assertEquals(f.queries.length, 3)
  }
})

Deno.test('a stored artifact from an older root version is never presented as current', async () => {
  const root = drawing()
  root.version = 5
  const result = await filePreviewPayload(fake(root).context, input)
  assertEquals(meta(result).status, 'pending')
  assertEquals(meta(result).version, 5)
  assertEquals(images(result), [])
})

Deno.test('version and full-input snapshot preconditions are enforced without rendering', async () => {
  const f = fake()
  assertEquals(code(await filePreviewPayload(f.context, { ...input, expected_version: 3 })), 'conflict')
  assertEquals(code(await filePreviewPayload(f.context, { ...input, expected_snapshot: 'f'.repeat(64) })), 'conflict')
  f.state.row!.drawing_previews.status = 'pending'
  assertEquals(code(await filePreviewPayload(f.context, { ...input, expected_snapshot: DIGEST })), 'conflict')
})

Deno.test('D2 metadata retains exact companion identities and missing-input markers', async () => {
  const root = drawing('art/a.d2')
  root.drawing_previews.metadata.inputs.push(
    { path: 'art/a.excalidraw', id: 'dddddddd-0000-4000-8000-000000000001', version: 3, sha256: 'c'.repeat(64) },
    { path: 'art/a.d2.json', id: null, version: null, sha256: null } as unknown as typeof root.drawing_previews.metadata.inputs[number],
  )
  const result = await filePreviewPayload(fake(root).context, { ...input, path: root.path })
  assertEquals(result.isError, undefined)
  assertEquals(meta(result).inputs, root.drawing_previews.metadata.inputs)
  assertEquals(meta(result).rendered_from, 'projected_diagram')
})

Deno.test('native and compressed Obsidian drawings read the same stored artifact contract', async () => {
  const root = drawing('art/a.excalidraw.md')
  const result = await filePreviewPayload(fake(root).context, { ...input, path: root.path })
  assertEquals(result.isError, undefined)
  assertEquals(images(result).length, 1)
})

Deno.test('crop requests use stored pixels at their available resolution, without a browser', async () => {
  const f = fake()
  const region = { x: 0.5, y: 0, width: 0.5, height: 0.5 }
  const result = await filePreviewPayload(f.context, { ...input, expected_snapshot: DIGEST, region })
  assertEquals(result.isError, undefined)
  assertEquals(meta(result).pixel_width, 1)
  assertEquals(meta(result).pixel_height, 1)
  assertEquals(meta(result).region, region)
  assertEquals(meta(result).snapshot, DIGEST)
  assertEquals(images(result).length, 1)
  assertStringIncludes((result.content[0] as { text: string }).text, 'stored image resolution')
})

Deno.test('invalid paths and unpinned/invalid regions are refused before database work', async () => {
  const f = fake()
  await withClient(f.context, async client => {
    for (const args of [
      { region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { expected_snapshot: DIGEST, region: { x: 0.8, y: 0, width: 0.5, height: 1 } },
      { path: '../a.excalidraw' },
    ]) {
      const result = await client.callTool({ name: 'get_file_preview', arguments: { ...input, ...args } })
      assertEquals(result.isError, true)
    }
  })
  assertEquals(f.queries.length, 0)
  assertEquals(code(await filePreviewPayload(f.context, { ...input, path: 'a.mdx' })), 'unsupported')
  assertEquals(f.queries.length, 0)
})

Deno.test('missing, inaccessible and nontext files never return pixels', async () => {
  for (const f of [fake(null), fake({ ...drawing(), kind: 'image' })]) {
    const result = await filePreviewPayload(f.context, input)
    assertEquals(result.isError, true)
    assertEquals(images(result), [])
  }
  const f = fake()
  f.state.readable = false
  assertEquals(code(await filePreviewPayload(f.context, input)), 'missing')
})

Deno.test('permission loss or root replacement before delivery withholds stored pixels', async () => {
  for (const change of ['revoke', 'replace']) {
    const f = fake()
    f.state.afterRead = () => {
      if (change === 'revoke') f.state.readable = false
      else f.state.row!.id = 'eeeeeeee-0000-4000-8000-000000000001'
    }
    const result = await filePreviewPayload(f.context, input)
    assertEquals(code(result), 'missing')
    assertEquals(images(result), [])
  }
})

Deno.test('a subsequent save cannot relabel the frozen stored version', async () => {
  const f = fake()
  f.state.afterRead = () => { f.state.row!.version = 5 }
  const result = await filePreviewPayload(f.context, input)
  assertEquals(result.isError, undefined)
  assertEquals(meta(result).version, 4)
})

Deno.test('background syntax errors remain explicit and require current access', async () => {
  const root = drawing() as unknown as Record<string, unknown>
  const row = root.drawing_previews as Record<string, unknown>
  row.status = 'error'; row.png = null; row.error_code = 'd2_error'; row.message = 'The diagram source has an error.'
  row.metadata = null
  const result = await filePreviewPayload(fake(root).context, input)
  assertEquals(code(result), 'd2_error')
  assertEquals(images(result), [])
})

Deno.test('corrupt bytes, dimensions, snapshots, root identities and oversized artifacts fail closed', async () => {
  const mutations: Array<(root: ReturnType<typeof drawing>) => void> = [
    root => { root.drawing_previews.png = '\\x00010203' },
    root => { root.drawing_previews.png = '\\x' + 'ff'.repeat(MAX_PREVIEW_PNG_BYTES + 1) },
    root => { root.drawing_previews.metadata.outcome.pixel_width = 3 },
    root => { root.drawing_previews.metadata.outcome.input_digest = 'c'.repeat(64) },
    root => { root.drawing_previews.metadata.inputs[0].id = 'eeeeeeee-0000-4000-8000-000000000001' },
    root => { root.drawing_previews.metadata.outcome.region = { x: 0, y: 0, width: 0.5, height: 1 } },
  ]
  for (const mutate of mutations) {
    const root = drawing(); mutate(root)
    const result = await filePreviewPayload(fake(root).context, input)
    assertEquals(result.isError, true)
    assertEquals(images(result), [])
  }
})

Deno.test('a background daily limit reports its reset instead of ordinary preparation', async () => {
  const root = drawing() as unknown as Record<string, unknown>
  const row = root.drawing_previews as Record<string, unknown>
  row.status = 'error'; row.png = null; row.metadata = null
  row.error_code = 'daily_limit'; row.message = 'Preview generation resumes at the next UTC day.'
  const result = await filePreviewPayload(fake(root).context, input)
  assertEquals(code(result), 'daily_limit')
  assert(Number(meta(result).retry_after) >= 1 && Number(meta(result).retry_after) <= 86400)
  assertEquals(images(result), [])
})

Deno.test('temporary renderer rate limits are not reported as a daily budget reset', async () => {
  const root = drawing() as unknown as Record<string, unknown>
  const row = root.drawing_previews as Record<string, unknown>
  row.status = 'error'; row.png = null; row.metadata = null
  row.error_code = 'rate_limit'; row.message = 'The renderer is temporarily busy.'
  const result = await filePreviewPayload(fake(root).context, input)
  assertEquals(code(result), 'rate_limit')
  assertEquals(meta(result).retry_after, undefined)
  assertEquals(images(result), [])
})

Deno.test('an already-cancelled read performs no work', async () => {
  const f = fake(), controller = new AbortController()
  controller.abort()
  const result = await filePreviewPayload(f.context, input, controller.signal)
  assertEquals(code(result), 'cancelled')
  assertEquals(f.queries.length, 0)
})
