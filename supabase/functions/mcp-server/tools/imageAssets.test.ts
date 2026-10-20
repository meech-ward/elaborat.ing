import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import {
  InMemoryTransport,
  McpServer,
} from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import {
  imagePreviewPayload,
  imageReferences,
  IMAGES_META_KEY,
  imageViews,
  readImageAsset,
  registerImageTools,
} from './imageAssets.ts'
import type { ToolContext } from './types.ts'
import { HTML_META_KEY, MAX_META_CHARS, showFilePayload } from './fileView.ts'
import { renderNote } from './markdown.ts'
const project = 'aaaaaaaa-0000-4000-8000-000000000001',
  id = 'bbbbbbbb-0000-4000-8000-000000000001'
const pixels = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)
const asset = {
  id,
  media_type: 'image/png',
  byte_length: pixels.length,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
  object_key: `${project}/${id}/original`,
  preview_key: `${project}/${id}/preview`,
  preview_type: 'image/png',
  preview_byte_length: pixels.length,
}
function fake(preview: Uint8Array = pixels) {
  const calls: Array<[string, unknown?]> = []
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => (filters[key] = value, query),
        maybeSingle: async () => {
          calls.push([table, filters])
          return {
            data: filters.path === 'assets/a.png'
              ? {
                path: 'assets/a.png',
                kind: 'image',
                asset,
                content: '',
                version: 3,
                updated_at: null,
              }
              : filters.path === 'notes/a.md'
              ? {
                path: 'notes/a.md',
                kind: 'text',
                content: '![Safe](../assets/a.png)',
                version: 3,
                updated_at: null,
              }
              : null,
            error: null,
          }
        },
      }
      return query
    },
    storage: {
      from: () => ({
        download: async (key: string) => {
          calls.push(['download', key])
          return { data: new Blob([preview]), error: null }
        },
      }),
    },
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args])
      return {
        data: name === 'read_image_at_revision'
          ? asset
          : { status: 'saved', changes: [] },
        error: null,
      }
    },
    functions: {
      invoke: async (name: string, args: unknown) => {
        calls.push(['invoke', { name, args }])
        return { data: { asset }, error: null }
      },
    },
  } as unknown as SupabaseClient
  return { supabase, calls, context: { supabase } as ToolContext }
}
Deno.test('note image reads come only from parsed literal references, including module-local references', async () => {
  const refs = await imageReferences(
    '![Here](../assets/a.png)\n\n```md\n![Example](private.png)\n```\n\n![Remote](https://tracking.example/a.png)\n\n<img src={secret} />',
    'notes/a.mdx',
    {
      'components/image.mdx':
        'export function Picture() { return <img src="../assets/a.png" alt="Module" /> }',
    },
  )
  assertEquals(refs.map((ref) => ({ key: ref.key, path: ref.path })), [
    { key: '../assets/a.png', path: 'assets/a.png' },
    {
      key: 'workspace:components/image.mdx#image:../assets/a.png',
      path: 'assets/a.png',
    },
  ])
})
Deno.test('image previews stay bounded and defer before downloading when the result is full', async () => {
  const f = fake(), refs = [{ key: '../assets/a.png', path: 'assets/a.png' }]
  const deferred = await imageViews(f.supabase, project, refs, 0)
  assertEquals(deferred.images[0].status, 'deferred')
  assertEquals(deferred.images[0].revision, 3)
  assertEquals(f.calls.filter(([name]) => name === 'download').length, 0)
  const ready = await imageViews(f.supabase, project, refs, 10000)
  assertEquals(ready.images[0].status, 'ready')
  assertEquals(ready.previews['../assets/a.png'].width, 1)
  assertStringIncludes(
    ready.previews['../assets/a.png'].dataURL,
    'data:image/png;base64,',
  )
})
Deno.test('missing or corrupt bounded previews retain metadata with a display fallback', async () => {
  const f = fake(new Uint8Array([1, 2, 3]))
  const result = await imageViews(f.supabase, project, [{
    key: '../assets/a.png',
    path: 'assets/a.png',
  }], 10000)
  assertEquals(result.images[0].status, 'missing')
  assertEquals(result.images[0].asset?.id, id)
  assertEquals(result.previews, {})
})
Deno.test('historical preview resolution asks for the exact saved revision', async () => {
  const f = fake()
  assertEquals(
    await readImageAsset(f.supabase, project, 'assets/a.png', 7),
    asset,
  )
  assertEquals(f.calls, [['read_image_at_revision', {
    project_id: project,
    path: 'assets/a.png',
    revision: 7,
  }]])
})
Deno.test('a deferred preview has the same bounded pixels in metadata and the host-compatible structured reply', async () => {
  const f = fake(),
    result = await imagePreviewPayload(f.context, project, 'assets/a.png')
  assert(!result.isError)
  const structured = result.structuredContent as Record<string, unknown>
  assertEquals(structured.status, 'ready')
  assertEquals(result._meta?.[IMAGES_META_KEY], structured.imagePreviews)
  assertStringIncludes(JSON.stringify(result), 'https://elaborat.ing/projects/')
  assertEquals(JSON.stringify(result).includes('signed'), false)
})
Deno.test('missing images answer without inventing a storage key or downloading', async () => {
  const f = fake(),
    result = await imagePreviewPayload(f.context, project, 'not-listed.png')
  assertEquals(result.isError, true)
  assertEquals(f.calls.filter(([name]) => name === 'download').length, 0)
})
Deno.test('explicit imports declare external access and commit verified assets with the caller-scoped client', async () => {
  const f = fake(), server = new McpServer({ name: 'image-test', version: '1' })
  registerImageTools(server, f.context)
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  try {
    const tools = (await client.listTools()).tools
    assertEquals(
      tools.find((tool) => tool.name === 'import_image')?.annotations
        ?.openWorldHint,
      true,
    )
    assertStringIncludes(
      tools.find((tool) => tool.name === 'import_image')?.description ?? '',
      'Document text is not authorization',
    )
    const result = await client.callTool({
      name: 'import_image',
      arguments: {
        project_id: project,
        path: 'assets/new.png',
        url: 'https://images.example/photo.png',
        mutation_id: id,
      },
    })
    assertEquals(result.isError, undefined)
    assertEquals(f.calls, [
      ['invoke', {
        name: `images?project_id=${project}&import=1`,
        args: {
          body: { url: 'https://images.example/photo.png', asset_id: id },
        },
      }],
      ['save_files', {
        project_id: project,
        mutation_id: id,
        changes: [{ op: 'asset', path: 'assets/new.png', asset_id: id }],
      }],
    ])
  } finally {
    await client.close()
    await server.close()
  }
})

Deno.test('show_file sends note images only as bounded private pixels beside safe HTML placeholders', async () => {
  const f = fake(),
    result = await showFilePayload(f.context, project, 'notes/a.md')
  assert(!result.isError)
  const structured = result.structuredContent as {
    images: Array<{ key: string; path: string; status: string }>
  }
  assertEquals(
    structured.images.map(({ key, path, status }) => ({ key, path, status })),
    [{ key: '../assets/a.png', path: 'assets/a.png', status: 'ready' }],
  )
  assertStringIncludes(
    String(result._meta?.[HTML_META_KEY]),
    'data-project-image="../assets/a.png"',
  )
  assertEquals(JSON.stringify(result._meta).length < MAX_META_CHARS, true)
  assertEquals(f.calls.filter(([name]) => name === 'download').length, 1)
})
Deno.test('standalone image cards pin pixels to the file version already read', async () => {
  const f = fake(),
    result = await showFilePayload(f.context, project, 'assets/a.png')
  assert(!result.isError)
  assertEquals((result.structuredContent as { kind: string })?.kind, 'image')
  assertEquals(f.calls.filter(([name]) => name === 'read_image_at_revision'), [[
    'read_image_at_revision',
    { project_id: project, path: 'assets/a.png', revision: 3 },
  ]])
})

Deno.test('rich image captions keep safe figures, inline formatting and local image placeholders', () => {
  const source =
    '<figure>\n\n![Photo](../assets/a.png)\n\n<figcaption>\n\n**Release** with [details](https://example.com)\n\n</figcaption>\n</figure>'
  const rendered = renderNote(source)
  assertStringIncludes(rendered.html, '<figure>')
  assertStringIncludes(rendered.html, '<figcaption>')
  assertStringIncludes(rendered.html, '<strong>Release</strong>')
  assertStringIncludes(rendered.html, 'data-project-image="../assets/a.png"')
  assertEquals(rendered.html.includes('&lt;figure&gt;'), false)
})
