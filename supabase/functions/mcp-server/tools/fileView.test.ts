import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_URI, MAX_EMBEDS, MCP_APP_MIME_TYPE, SVG_META_KEY } from './fileView.ts'
import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { registerTools, type ToolContext } from './index.ts'
import { renderMarkdown, renderNote } from './markdown.ts'

// show_file and its MCP Apps view, on a real McpServer through a real MCP
// client, with a stand-in Supabase client that answers the one file query.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const UPDATED = '2026-09-26T00:00:00Z'

type Row = { path: string; content: string; version: number; updated_at: string }

const file = (path: string, content: string): Row => ({ path, content, version: 1, updated_at: UPDATED })

/** A stand-in for the project's files: one row by path, or the rows whose paths are listed. */
async function withClient<T>(files: Row[], use: (client: Client, queries: unknown[][][]) => Promise<T>): Promise<T> {
  const queries: unknown[][][] = []
  const supabase = {
    from(table: string) {
      const query: unknown[][] = [['from', table]]
      queries.push(query)
      const arg = (name: string, key: string) => query.find((step) => step[0] === name && step[1] === key)?.[2]
      const builder = {
        select: (...args: unknown[]) => (query.push(['select', ...args]), builder),
        eq: (...args: unknown[]) => (query.push(['eq', ...args]), builder),
        in: (...args: unknown[]) => (query.push(['in', ...args]), builder),
        maybeSingle: () => Promise.resolve({ data: files.find((row) => row.path === arg('eq', 'path')) ?? null, error: null }),
        then: (resolve: (value: unknown) => void) => {
          const paths = arg('in', 'path') as string[]
          resolve({ data: files.filter((row) => paths.includes(row.path)).map(({ path, content }) => ({ path, content })), error: null })
        },
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

function showFile(path: string, files: Row[]) {
  return withClient(files, async (client, queries) => ({
    result: (await client.callTool({ name: 'show_file', arguments: { project_id: PROJECT, path } })) as CallToolResult,
    queries,
  }))
}

Deno.test('the file view is listed and read as an MCP App resource', async () => {
  await withClient([], async (client) => {
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

    // Hosts that have not refreshed the tool list still get the view at the old URI.
    const old = await client.readResource({ uri: 'ui://elaborating/file-view-v1.html' })
    assert('text' in old.contents[0] && old.contents[0].text === FILE_VIEW_HTML)
  })
})

Deno.test('show_file advertises the view and read_file stays text only', async () => {
  await withClient([], async (client) => {
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
  const { result, queries } = await showFile('notes/plan.md', [{ path: 'notes/plan.md', content, version: 3, updated_at: UPDATED }])
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
    embeds: [],
  })
  assertEquals(result._meta, undefined)
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
    const { result } = await showFile(path, [{ path, content: '{}', version: 1, updated_at: UPDATED }])
    const view = result.structuredContent as Record<string, unknown>
    assertEquals([view.kind, view.html, view.url], [kind, null, `https://elaborat.ing/projects/${PROJECT}/${encoded}`])
  }

  const long = 'A line of the note.\n'.repeat(3000)
  const { result } = await showFile('long.md', [{ path: 'long.md', content: long, version: 1, updated_at: UPDATED }])
  const view = result.structuredContent as Record<string, unknown>
  assertEquals(view.truncated, true)
  assert(String(view.html).length < long.length)
})

Deno.test('show_file reports a missing file', async () => {
  const { result } = await showFile('nope.md', [])
  assert(result.isError)
  assertEquals(result.content, [{ type: 'text', text: 'No file at nope.md in this project. Use list_files to see what exists.' }])
})

const SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  elements: [
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2, roughness: 1, seed: 3 },
    { id: 't', type: 'text', x: 10, y: 18, width: 100, height: 25, text: 'Hello', fontSize: 20, fontFamily: 5, textAlign: 'center', strokeColor: '#1e1e1e' },
  ],
})

Deno.test('a note\'s Drawing and Diagram tags become embeds; other MDX stays text', () => {
  const { html, embeds } = renderNote(
    [
      'import Chart from "./chart.tsx"',
      '',
      '<Drawing src="art/flow chart.excalidraw" />',
      '',
      '<Diagram',
      '  src="flows/signup.d2"',
      '/>',
      '',
      "<Drawing src='art/a&amp;b.excalidraw.md'/>",
      '<Drawing src="art/flow chart.excalidraw" />',
      '',
      'Inline <Drawing src="x.excalidraw" /> in a sentence, and <Callout>hi</Callout>.',
      '',
      '<Drawing src="../outside.excalidraw" />',
      '',
      '<Drawing src={path} />',
      '',
      '- <Diagram src="in/list.d2" />',
    ].join('\n')
  )
  assertEquals(embeds, [
    { kind: 'drawing', path: 'art/flow chart.excalidraw' },
    { kind: 'diagram', path: 'flows/signup.d2' },
    { kind: 'drawing', path: 'art/a&b.excalidraw.md' },
    { kind: 'drawing', path: 'art/flow chart.excalidraw' },
    { kind: 'drawing', path: 'x.excalidraw' },
    { kind: 'diagram', path: 'in/list.d2' },
  ])
  for (let i = 0; i < embeds.length; i++) assertStringIncludes(html, `<figure class="embed" data-embed="${i}"></figure>`)
  assertStringIncludes(html, 'import Chart from "./chart.tsx"')
  assertStringIncludes(html, '&#x3C;Callout>hi&#x3C;/Callout>')
  assertStringIncludes(html, '&#x3C;Drawing src="../outside.excalidraw" />')
  assertStringIncludes(html, '&#x3C;Drawing src={path} />')
  assertFalse(html.includes('<Drawing'), html)
})

Deno.test('show_file draws a note\'s drawings and diagrams, and says why when it cannot', async () => {
  const note = [
    '# Plan',
    '<Drawing src="art/flow.excalidraw" />',
    '<Diagram src="flows/signup.d2" />',
    '<Diagram src="flows/new.d2" />',
    '<Drawing src="art/gone.excalidraw" />',
    '<Drawing src="art/flow.excalidraw" />',
    '<Drawing src="art/broken.excalidraw" />',
  ].join('\n\n')
  const { result, queries } = await showFile('plan.mdx', [
    file('plan.mdx', note),
    file('art/flow.excalidraw', SCENE),
    file('flows/signup.d2', 'a -> b'),
    file('flows/signup.excalidraw', SCENE),
    file('flows/new.d2', 'c -> d'),
    file('art/broken.excalidraw', '{"elements": 3}'),
  ])
  // One more query, as the user, for the drawings and each diagram's source and companion.
  assertEquals(queries.length, 2)
  assertEquals(queries[1], [
    ['from', 'project_files'],
    ['select', 'path, content'],
    ['eq', 'project_id', PROJECT],
    ['in', 'path', ['art/flow.excalidraw', 'flows/signup.d2', 'flows/signup.excalidraw', 'flows/new.d2', 'flows/new.excalidraw', 'art/gone.excalidraw', 'art/broken.excalidraw']],
  ])
  const view = result.structuredContent as { embeds: { kind: string; path: string; url: string; status: string }[]; html: string }
  assertEquals(view.embeds.map((embed) => [embed.kind, embed.path, embed.status]), [
    ['drawing', 'art/flow.excalidraw', 'drawn'],
    ['diagram', 'flows/signup.d2', 'drawn'],
    ['diagram', 'flows/new.d2', 'not_drawn'],
    ['drawing', 'art/gone.excalidraw', 'missing'],
    ['drawing', 'art/flow.excalidraw', 'drawn'],
    ['drawing', 'art/broken.excalidraw', 'unreadable'],
  ])
  assertEquals(view.embeds[1].url, `https://elaborat.ing/projects/${PROJECT}/flows/signup.d2`)
  assertStringIncludes(view.html, '<figure class="embed" data-embed="5"></figure>')
  // The SVGs go in _meta, which the host passes to the view and keeps from the model.
  const svgs = (result._meta as Record<string, Record<string, string>>)[SVG_META_KEY]
  assertEquals(Object.keys(svgs), ['art/flow.excalidraw', 'flows/signup.d2'])
  assert(svgs['flows/signup.d2'].startsWith('<svg '))
  assertStringIncludes(svgs['flows/signup.d2'], '>Hello</text>')
  assertFalse(JSON.stringify(result.structuredContent).includes('<svg'))
})

Deno.test('show_file draws a drawing or diagram shown on its own', async () => {
  const drawing = await showFile('art/flow.excalidraw', [file('art/flow.excalidraw', SCENE)])
  assertEquals(drawing.queries.length, 1)
  const drawn = drawing.result.structuredContent as { embeds: unknown[] }
  assertEquals(drawn.embeds, [{ kind: 'drawing', path: 'art/flow.excalidraw', url: `https://elaborat.ing/projects/${PROJECT}/art/flow.excalidraw`, status: 'drawn' }])
  assert((drawing.result._meta as Record<string, Record<string, string>>)[SVG_META_KEY]['art/flow.excalidraw'].startsWith('<svg '))

  const diagram = await showFile('flows/signup.d2', [file('flows/signup.d2', 'a -> b'), file('flows/signup.excalidraw', SCENE)])
  assertEquals((diagram.result.structuredContent as { embeds: { status: string }[] }).embeds[0].status, 'drawn')
  assert((diagram.result._meta as Record<string, Record<string, string>>)[SVG_META_KEY]['flows/signup.d2'].startsWith('<svg '))

  // Never opened in the app, so there is no canvas to draw yet.
  const fresh = await showFile('flows/new.d2', [file('flows/new.d2', 'a -> b')])
  assertEquals((fresh.result.structuredContent as { embeds: { status: string }[] }).embeds[0].status, 'not_drawn')
  assertEquals(fresh.result._meta, undefined)
})

Deno.test(`show_file draws at most ${MAX_EMBEDS} different files for a note`, async () => {
  const paths = Array.from({ length: MAX_EMBEDS + 2 }, (_, i) => `art/d${i}.excalidraw`)
  const note = [...paths, paths[0]].map((path) => `<Drawing src="${path}" />`).join('\n\n')
  const { result, queries } = await showFile('many.md', [file('many.md', note), ...paths.map((path) => file(path, SCENE))])
  assertEquals(queries[1][3], ['in', 'path', paths.slice(0, MAX_EMBEDS)])
  const statuses = (result.structuredContent as { embeds: { status: string }[] }).embeds.map((embed) => embed.status)
  assertEquals(statuses, [...Array(MAX_EMBEDS).fill('drawn'), 'not_shown', 'not_shown', 'drawn'])
  assertEquals(Object.keys((result._meta as Record<string, Record<string, string>>)[SVG_META_KEY]).length, MAX_EMBEDS)
})
