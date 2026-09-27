import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_URI, MCP_APP_MIME_TYPE } from './fileView.ts'
import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { registerTools, type ToolContext } from './index.ts'
import { renderMarkdown } from './markdown.ts'

// show_file and its MCP Apps view, on a real McpServer through a real MCP
// client, with a stand-in Supabase client that answers the one file query.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const UPDATED = '2026-09-26T00:00:00Z'

type Row = { path: string; content: string; version: number; updated_at: string } | null

async function withClient<T>(row: Row, use: (client: Client, queries: unknown[][][]) => Promise<T>): Promise<T> {
  const queries: unknown[][][] = []
  const supabase = {
    from(table: string) {
      const query: unknown[][] = [['from', table]]
      queries.push(query)
      const builder = {
        select: (...args: unknown[]) => (query.push(['select', ...args]), builder),
        eq: (...args: unknown[]) => (query.push(['eq', ...args]), builder),
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      }
      return builder
    },
  } as unknown as SupabaseClient
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase } as unknown as ToolContext)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await use(client, queries)
  } finally {
    await client.close()
    await server.close()
  }
}

function showFile(path: string, row: Row) {
  return withClient(row, async (client, queries) => ({
    result: (await client.callTool({ name: 'show_file', arguments: { project_id: PROJECT, path } })) as CallToolResult,
    queries,
  }))
}

Deno.test('the file view is listed and read as an MCP App resource', async () => {
  await withClient(null, async (client) => {
    const { resources } = await client.listResources()
    const listed = resources.find((resource) => resource.uri === FILE_VIEW_URI)
    assertEquals(listed?.mimeType, 'text/html;profile=mcp-app')

    const { contents } = await client.readResource({ uri: FILE_VIEW_URI })
    assertEquals(contents.length, 1)
    const [content] = contents
    assertEquals(content.uri, FILE_VIEW_URI)
    assertEquals(content.mimeType, MCP_APP_MIME_TYPE)
    assert('text' in content && content.text === FILE_VIEW_HTML)
    assertEquals(content._meta, { ui: { prefersBorder: false } })
  })
})

Deno.test('show_file advertises the view and read_file stays text only', async () => {
  await withClient(null, async (client) => {
    const { tools } = await client.listTools()
    const show = tools.find((tool) => tool.name === 'show_file')
    assertEquals(show?._meta, { ui: { resourceUri: FILE_VIEW_URI } })
    assertEquals(show?.annotations?.readOnlyHint, true)
    assertEquals(tools.find((tool) => tool.name === 'read_file')?._meta, undefined)
  })
})

Deno.test('the view is self-contained: no URL but elaborat.ing, nothing loaded from outside', () => {
  const urls = FILE_VIEW_HTML.match(/https?:\/\/[^\s"'`)<>]+/gi) ?? []
  assert(urls.length > 0)
  for (const url of urls) assertEquals(new URL(url).origin, 'https://elaborat.ing', url)
  for (const pattern of [/\bsrc\s*=/i, /<link\b/i, /@import/i, /url\(/, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/]) {
    assertFalse(pattern.test(FILE_VIEW_HTML.replaceAll(/https:\/\/elaborat\.ing\/?/g, '')), `view matches ${pattern}`)
  }
  assertFalse(FILE_VIEW_HTML.includes('\u2014'), 'no em dashes in the view copy')
})

Deno.test('rendered Markdown shows raw HTML as text and drops unsafe links and images', () => {
  const html = renderMarkdown(
    [
      '---',
      'title: Secret frontmatter',
      '---',
      '# Plan',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      'Some <b>bold</b>, [bad](javascript:alert(1)), [good](https://example.com) and ![a chart](https://example.com/c.png).',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')
  )
  assertStringIncludes(html, '<h1>Plan</h1>')
  assertStringIncludes(html, '&#x3C;script>alert(1)&#x3C;/script>')
  assertStringIncludes(html, '&#x3C;img src=x onerror=alert(1)>')
  assertStringIncludes(html, 'Some &#x3C;b>bold&#x3C;/b>')
  assertStringIncludes(html, '<a href="https://example.com">good</a>')
  assertStringIncludes(html, 'a chart')
  assertStringIncludes(html, '<table>')
  assertFalse(/<(script|img|iframe|style)\b/i.test(html), html)
  assertFalse(/<[a-z][^>]*\son\w+=/i.test(html), html)
  assertFalse(html.includes('javascript:'), html)
  assertFalse(html.includes('Secret frontmatter'), html)
})

Deno.test('show_file reads the file as the user and returns the rendered note', async () => {
  const content = '# Plan\n\nShip it <b>soon</b>.'
  const { result, queries } = await showFile('notes/plan.md', { path: 'notes/plan.md', content, version: 3, updated_at: UPDATED })
  assertEquals(queries, [[
    ['from', 'project_files'],
    ['select', 'path, content, version, updated_at'],
    ['eq', 'project_id', PROJECT],
    ['eq', 'path', 'notes/plan.md'],
  ]])
  const url = `https://elaborat.ing/projects/${PROJECT}/notes/plan.md`
  assertEquals(result.structuredContent, {
    project_id: PROJECT,
    path: 'notes/plan.md',
    kind: 'note',
    version: 3,
    updated_at: UPDATED,
    url,
    html: renderMarkdown(content),
    truncated: false,
  })
  assertEquals(result.content, [{ type: 'text', text: `Showing notes/plan.md (version 3) to the user. Open it in elaborat.ing: ${url}` }])
})

Deno.test('show_file shows drawings and diagrams as a card and cuts long notes', async () => {
  const cases: [string, string, string][] = [
    ['art/flow chart.excalidraw', 'drawing', 'art/flow%20chart.excalidraw'],
    ['art/sketch.excalidraw.md', 'drawing', 'art/sketch.excalidraw.md'],
    ['flows/signup.d2', 'diagram', 'flows/signup.d2'],
    ['data/rows.json', 'file', 'data/rows.json'],
  ]
  for (const [path, kind, encoded] of cases) {
    const { result } = await showFile(path, { path, content: '{}', version: 1, updated_at: UPDATED })
    const view = result.structuredContent as Record<string, unknown>
    assertEquals([view.kind, view.html, view.url], [kind, null, `https://elaborat.ing/projects/${PROJECT}/${encoded}`])
  }

  const long = 'A line of the note.\n'.repeat(3000)
  const { result } = await showFile('long.md', { path: 'long.md', content: long, version: 1, updated_at: UPDATED })
  const view = result.structuredContent as Record<string, unknown>
  assertEquals(view.truncated, true)
  assert(String(view.html).length < long.length)
})

Deno.test('show_file reports a missing file', async () => {
  const { result } = await showFile('nope.md', null)
  assert(result.isError)
  assertEquals(result.content, [{ type: 'text', text: 'No file at nope.md in this project. Use list_files to see what exists.' }])
})
