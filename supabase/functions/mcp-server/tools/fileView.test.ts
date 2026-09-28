import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { CARD_SCRIPT, CARD_STYLE } from './cardEditorScript.ts'
import { COMPONENTS_META_KEY, importedPaths } from './componentSources.ts'
import { FILE_VIEW_URI, HTML_META_KEY, MAX_EMBEDS, MCP_APP_MIME_TYPE, SOURCE_META_KEY, SVG_META_KEY, sourceHash } from './fileView.ts'
import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { registerTools, type ToolContext } from './index.ts'
import { renderMarkdown, renderNote } from './markdown.ts'

// show_file and its MCP Apps view, on a real McpServer through a real MCP
// client, with a stand-in Supabase client that answers the one file query.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
/** The signed-in user, and the project's owner unless a test says otherwise. */
const ME = '0b6a4a52-6f3e-4c1a-9d59-3b7f1c2a9e01'
const UPDATED = '2026-09-26T00:00:00Z'
/** Another member of a shared project. */
const ANA = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f'
/** The project's members, as list_members answers. */
const MEMBERS = [
  { user_id: ANA, email: 'ana@example.com', name: 'Ana', role: 'owner' },
  { user_id: ME, email: 'me@example.com', name: null, role: 'editor' },
]

type Row = { path: string; content: string; version: number; updated_at: string; updated_by?: string | null }

const file = (path: string, content: string): Row => ({ path, content, version: 1, updated_at: UPDATED })

/**
 * A stand-in for the project's files: one row by path, or the rows whose
 * paths are listed. save_files puts files with the database's version check:
 * a put whose base_version is not the file's version is a conflict.
 */
async function withClient<T>(files: Row[], use: (client: Client, queries: unknown[][][]) => Promise<T>, owner = ME): Promise<T> {
  const queries: unknown[][][] = []
  let revision = Math.max(0, ...files.map((row) => row.version))
  const supabase = {
    rpc(name: string, args: { changes: { op: string; path: string; content: string; base_version?: number }[] }) {
      queries.push([['rpc', name, JSON.parse(JSON.stringify(args))]])
      if (name === 'list_members') return Promise.resolve({ data: MEMBERS, error: null })
      const [change] = args.changes
      const row = files.find((entry) => entry.path === change.path)
      if (change.op !== 'put' || (row?.version ?? undefined) !== change.base_version) {
        const current = row ? { version: row.version, content: row.content } : null
        return Promise.resolve({ data: { status: 'conflict', conflicts: [{ path: change.path, base_version: change.base_version ?? null, current }] }, error: null })
      }
      revision++
      if (row) Object.assign(row, { content: change.content, version: revision })
      else files.push({ path: change.path, content: change.content, version: revision, updated_at: UPDATED })
      return Promise.resolve({ data: { status: 'saved', changes: [{ op: 'put', path: change.path, version: revision }] }, error: null })
    },
    from(table: string) {
      const query: unknown[][] = [['from', table]]
      queries.push(query)
      const arg = (name: string, key: string) => query.find((step) => step[0] === name && step[1] === key)?.[2]
      const builder = {
        select: (...args: unknown[]) => (query.push(['select', ...args]), builder),
        eq: (...args: unknown[]) => (query.push(['eq', ...args]), builder),
        in: (...args: unknown[]) => (query.push(['in', ...args]), builder),
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'projects' ? { owner_id: owner } : (files.find((row) => row.path === arg('eq', 'path')) ?? null),
            error: null,
          }),
        then: (resolve: (value: unknown) => void) => {
          const paths = arg('in', 'path') as string[]
          const rows = files.filter((row) => paths.includes(row.path))
          const editors = query.some((step) => step[0] === 'select' && step[1] === 'path, updated_by')
          resolve({ data: rows.map(({ path, content, updated_by }) => (editors ? { path, updated_by: updated_by ?? null } : { path, content })), error: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase, userClaims: { id: ME } } as unknown as ToolContext)
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

function showFile(path: string, files: Row[], owner = ME) {
  return withClient(
    files,
    async (client, queries) => ({
      result: (await client.callTool({ name: 'show_file', arguments: { project_id: PROJECT, path } })) as CallToolResult,
      queries,
    }),
    owner,
  )
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
    // The view may load its editor and previews from the app's site, and from nowhere else.
    assertEquals(content._meta, {
      ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['https://elaborat.ing'] } },
      'openai/widgetCSP': { connect_domains: [], resource_domains: ['https://elaborat.ing'] },
    })

    // Hosts that have not refreshed the tool list still get the view at the old URI.
    const old = await client.readResource({ uri: 'ui://elaborating/file-view-v1.html' })
    assert('text' in old.contents[0] && old.contents[0].text === FILE_VIEW_HTML)
  })
})

Deno.test('show_file advertises the view and read_file stays text only', async () => {
  await withClient([], async (client) => {
    const { tools } = await client.listTools()
    const show = tools.find((tool) => tool.name === 'show_file')
    // The view can call show_file again, to show the note as saved.
    assertEquals(show?._meta, { ui: { visibility: ['model', 'app'], resourceUri: FILE_VIEW_URI }, 'openai/widgetAccessible': true })
    assertEquals(show?.annotations?.readOnlyHint, true)
    assertEquals(tools.find((tool) => tool.name === 'read_file')?._meta, undefined)
    // The view saves an edited note with write_file, which renders no view of its own.
    assertEquals(tools.find((tool) => tool.name === 'write_file')?._meta, { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true })
  })
})

Deno.test('the view is self-contained: no URL but elaborat.ing, nothing loaded from outside', () => {
  // The script is checked on its own below: its libraries' error messages name their docs.
  assert(CARD_SCRIPT.length > 0 && FILE_VIEW_HTML.includes(CARD_SCRIPT) && FILE_VIEW_HTML.includes(CARD_STYLE))
  // The stylesheet's license banner names its project's site; it loads nothing.
  const view = FILE_VIEW_HTML.replace(CARD_SCRIPT, '').replaceAll(/\/\*![^*]*\*\//g, '')
  for (const url of view.match(/https?:\/\/[^\s"'`)<>]+/gi) ?? []) assertEquals(new URL(url).origin, 'https://elaborat.ing', url)
  for (const pattern of [/\bsrc\s*=/i, /<link\b/i, /@import/i, /url\(/, /@font-face/i, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/]) {
    assertFalse(pattern.test(view.replaceAll(/https:\/\/elaborat\.ing\/?/g, '')), `view matches ${pattern}`)
  }
  assertFalse(view.includes('\u2014'), 'no em dashes in the view')
})

Deno.test('the card script makes no requests, runs no code from strings, and stays inside its script element', () => {
  for (const pattern of [/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon|new Worker/, /\beval\(|new Function\b/, /<\/script|<!--/i]) {
    assertFalse(pattern.test(CARD_SCRIPT), `card script matches ${pattern}`)
  }
  // The modules it imports when needed, and its fonts, are the app's own, from the origin the view declares.
  const modules = new Set([...CARD_SCRIPT.matchAll(/["'`](https:\/\/[^"'`]+\.(?:js|css|woff2))["'`]/g)].map((match) => match[1]))
  assertEquals(modules.size, 7)
  for (const url of modules) assert(url.startsWith('https://elaborat.ing/chat-card/'), url)
  // What hosts load for the view: the card and its stylesheet. Its fonts, the editor and the
  // component previews are files it loads when it needs them.
  assert(FILE_VIEW_HTML.length < 500_000, `the view is ${FILE_VIEW_HTML.length} characters`)
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
    truncated: false,
    embeds: [],
  })
  // The note's HTML and source go to the view, never to the model.
  assertEquals(result._meta, { [HTML_META_KEY]: renderMarkdown(content), [SOURCE_META_KEY]: content })
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
    assertEquals([view.kind, view.url], [kind, `https://elaborat.ing/projects/${PROJECT}/${encoded}`])
    assertEquals(result._meta?.[HTML_META_KEY], undefined)
  }

  const long = 'A line of the note.\n'.repeat(3000)
  const { result } = await showFile('long.md', [{ path: 'long.md', content: long, version: 1, updated_at: UPDATED }])
  const view = result.structuredContent as Record<string, unknown>
  assertEquals(view.truncated, true)
  assert(String(result._meta?.[HTML_META_KEY]).length < long.length)
  // A note too long to show whole is not edited in the view.
  assertEquals(result._meta?.[SOURCE_META_KEY], undefined)
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

Deno.test('a note\'s Drawing and Diagram tags become embeds; other MDX stays text, imports go', () => {
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
  // MDX import lines are code, not content: dropped.
  assertFalse(html.includes('chart.tsx'))
  assertStringIncludes(html, '&#x3C;Callout>hi&#x3C;/Callout>')
  assertStringIncludes(html, '&#x3C;Drawing src="../outside.excalidraw" />')
  assertStringIncludes(html, '&#x3C;Drawing src={path} />')
  assertFalse(html.includes('<Drawing'), html)
})

Deno.test('a Callout written as one block becomes a callout around its Markdown; other forms stay text', () => {
  const { html, embeds } = renderNote(
    [
      '<Callout tone="warn" title="Heads up">',
      '  Agents act as **you**.',
      '  <Drawing src="art/in.excalidraw" />',
      '</Callout>',
      '',
      '<Callout type="note">Keep this as it is.</Callout>',
      '',
      '<Callout tone={tone}>Not a literal tone</Callout>',
      '',
      '<Callout tone="danger"><a href="javascript:alert(1)">x</a></Callout>',
    ].join('\n')
  )
  assertStringIncludes(html, '<aside class="callout" data-tone="warn"><p class="callout-title">Heads up</p>')
  assertStringIncludes(html, 'Agents act as <strong>you</strong>.')
  assertStringIncludes(html, '<aside class="callout" data-tone="info"><p>Keep this as it is.</p></aside>')
  assertStringIncludes(html, '&#x3C;Callout tone={tone}>')
  // Raw HTML inside a callout is text too, and an unknown tone is info.
  assertStringIncludes(html, '<aside class="callout" data-tone="info"><p>&#x3C;a href="javascript:alert(1)">x&#x3C;/a></p></aside>')
  assertFalse(html.includes('<a '), html)
  assertEquals(embeds, [{ kind: 'drawing', path: 'art/in.excalidraw' }])
})

Deno.test('a Callout with blank lines inside, or a tone in braces, is a callout too', () => {
  const { html } = renderNote(
    [
      '<Callout tone="warn">',
      '  First paragraph.',
      '',
      '  Second paragraph.',
      '</Callout>',
      '',
      'After.',
      '',
      '<Callout tone={"error"} title={\'Stop\'}>Braced props.</Callout>',
      '',
      '<Callout tone="note">',
      '  Never closed.',
      '',
      'Still text.',
    ].join('\n')
  )
  const flat = html.replace(/\n/g, '')
  assertStringIncludes(flat, '<aside class="callout" data-tone="warn"><p>First paragraph.</p><p>Second paragraph.</p></aside><p>After.</p>')
  assertStringIncludes(flat, '<aside class="callout" data-tone="error"><p class="callout-title">Stop</p><p>Braced props.</p></aside>')
  assertStringIncludes(html, '&#x3C;Callout tone="note">')
  assertStringIncludes(html, '<p>Still text.</p>')
  assertFalse(html.includes('&#x3C;/Callout>'), html)
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
  // One more query, as the user, for the drawings and each diagram's source, companion and layout record.
  assertEquals(queries.length, 2)
  assertEquals(queries[1], [
    ['from', 'project_files'],
    ['select', 'path, content'],
    ['eq', 'project_id', PROJECT],
    ['in', 'path', ['art/flow.excalidraw', 'flows/signup.d2', 'flows/signup.excalidraw', 'flows/signup.d2.json', 'flows/new.d2', 'flows/new.excalidraw', 'flows/new.d2.json', 'art/gone.excalidraw', 'art/broken.excalidraw']],
  ])
  const view = result.structuredContent as { embeds: { kind: string; path: string; url: string; status: string }[] }
  assertEquals(view.embeds.map((embed) => [embed.kind, embed.path, embed.status]), [
    ['drawing', 'art/flow.excalidraw', 'drawn'],
    ['diagram', 'flows/signup.d2', 'drawn'],
    ['diagram', 'flows/new.d2', 'not_drawn'],
    ['drawing', 'art/gone.excalidraw', 'missing'],
    ['drawing', 'art/flow.excalidraw', 'drawn'],
    ['drawing', 'art/broken.excalidraw', 'unreadable'],
  ])
  assertEquals(view.embeds[1].url, `https://elaborat.ing/projects/${PROJECT}/flows/signup.d2`)
  assertStringIncludes(String(result._meta?.[HTML_META_KEY]), '<figure class="embed" data-embed="5"></figure>')
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
  // Only notes are edited in the view.
  assertFalse(SOURCE_META_KEY in (drawing.result._meta ?? {}))
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

Deno.test('a note drops MDX import and export lines but keeps prose that starts with those words', () => {
  const html = renderMarkdown('import { Chart } from "./chart.tsx"\nexport const x = 1\n\n# Plan\n\nImport the data first.\n')
  assertFalse(html.includes('chart.tsx'))
  assertFalse(html.includes('export const'))
  assertStringIncludes(html, 'Plan')
  assertStringIncludes(html, 'Import the data first.')
})

Deno.test('the card saves with the version it showed, and a note changed since then is a conflict', async () => {
  const source = '---\ntitle: Plan\n---\n# Plan\n\nShip it *soon*.\n\n<Drawing src="art/flow.excalidraw" />\n'
  const edited = source.replace('Ship it', 'Ship it this week,')
  const files = [file('notes/plan.mdx', source), file('art/flow.excalidraw', SCENE)]
  files[0].version = 4
  await withClient(files, async (client, queries) => {
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult
    const shown = await call('show_file', { project_id: PROJECT, path: 'notes/plan.mdx' })
    const view = shown.structuredContent as { version: number }
    assertEquals(view.version, 4)
    assertEquals((shown._meta as Record<string, string>)[SOURCE_META_KEY], source)

    // What the card sends on Save: the whole edited source and the version it showed.
    const saved = await call('write_file', { project_id: PROJECT, path: 'notes/plan.mdx', content: edited, base_version: view.version })
    assertEquals(queries.at(-1), [['rpc', 'save_files', {
      project_id: PROJECT,
      mutation_id: (queries.at(-1)![0][2] as { mutation_id: string }).mutation_id,
      changes: [{ op: 'put', path: 'notes/plan.mdx', content: edited, base_version: 4 }],
    }]])
    assertEquals(saved.structuredContent, { status: 'saved', changes: [{ op: 'put', path: 'notes/plan.mdx', version: 5 }] })

    // The card reloads itself and shows the saved version.
    const reloaded = await call('show_file', { project_id: PROJECT, path: 'notes/plan.mdx' })
    assertEquals((reloaded.structuredContent as { version: number }).version, 5)
    assertEquals((reloaded._meta as Record<string, string>)[SOURCE_META_KEY], edited)

    // A second card still showing version 4 cannot overwrite version 5.
    const stale = await call('write_file', { project_id: PROJECT, path: 'notes/plan.mdx', content: source, base_version: 4 })
    const conflict = stale.structuredContent as { status: string; conflicts: { current: { version: number; content: string } }[] }
    assertEquals(conflict.status, 'conflict')
    assertEquals(conflict.conflicts[0].current, { version: 5, content: edited })
    assertEquals(files[0].content, edited)
  })
})

Deno.test('show_file marks a diagram drawn before its source changed, and still draws it', async () => {
  // The app's fingerprint, as src/features/structured/sourceHash.ts computes it.
  assertEquals(sourceHash('a -> b'), '294b0b8d')
  for (const [recorded, status] of [[sourceHash('a -> b'), 'drawn'], [sourceHash('a -> c'), 'stale']]) {
    const { result } = await showFile('flows/signup.d2', [
      file('flows/signup.d2', 'a -> b'),
      file('flows/signup.excalidraw', SCENE),
      file('flows/signup.d2.json', JSON.stringify({ version: 1, sourceHash: recorded })),
    ])
    assertEquals((result.structuredContent as { embeds: { status: string }[] }).embeds[0].status, status)
    assert((result._meta as Record<string, Record<string, string>>)[SVG_META_KEY]['flows/signup.d2'].startsWith('<svg '))
  }
})

Deno.test('a note is marked mdx when the HTML shows or drops some of its MDX, and not for embeds and callouts alone', () => {
  assertFalse(renderNote('# Plan\n\n<Drawing src="a.excalidraw" />\n\n<Callout tone="warn">Careful.</Callout>\n').mdx)
  assertFalse(renderNote('# Plan\n\n```mdx\n<Chart />\n```\n\nSay `<Chart />` in text.\n').mdx)
  assert(renderNote('import { Chart } from "workspace:components/chart.mdx"\n\n# Plan\n').mdx)
  assert(renderNote('# Plan\n\n<Chart data={[1, 2]} />\n').mdx)
  assert(renderNote('Text with <Badge>new</Badge> inline.\n').mdx)
  assert(renderNote('Two and two make {2 + 2}.\n').mdx)
  assert(renderNote('<Callout>\n  <Chart />\n</Callout>\n').mdx)
})

Deno.test('the component files a source imports are found after from, as the app accepts them', () => {
  const source = [
    "import { Chart } from 'workspace:components/chart.mdx'",
    'import { A, B } from "workspace:components/ab.mdx"',
    'import {',
    '  C,',
    '} from "workspace:shared/c.MDX"',
    'import { useState } from "react"',
    'import { D } from "workspace:../outside.mdx"',
    'import { E } from "workspace:components/e.tsx"',
    "import { Chart as Again } from 'workspace:components/chart.mdx'",
  ].join('\n')
  assertEquals(importedPaths(source), ['components/chart.mdx', 'components/ab.mdx', 'shared/c.MDX'])
})

const COMPONENT_NOTE = [
  '---',
  'title: Plan',
  '---',
  "import { Chart } from 'workspace:components/chart.mdx'",
  '',
  '# Plan',
  '',
  '<Chart title="Q3" />',
  '',
].join('\n')

Deno.test('show_file sends an MDX note with components the component files it imports, level by level, as the user', async () => {
  const { result, queries } = await showFile('notes/plan.mdx', [
    file('notes/plan.mdx', COMPONENT_NOTE),
    file('components/chart.mdx', "import { Axis } from 'workspace:components/axis.mdx'\n\nexport const Chart = () => <Axis />\n"),
    file('components/axis.mdx', 'export function Axis() { return <span>axis</span> }\n'),
    file('components/unused.mdx', 'export const Unused = () => null\n'),
  ])
  assertEquals(queries.slice(1).map((query) => query.at(-1)), [
    ['in', 'path', ['components/chart.mdx']],
    ['in', 'path', ['components/axis.mdx']],
    // Whose project it is: the view asks before running a shared note's components.
    ['eq', 'id', PROJECT],
  ])
  assertEquals((result.structuredContent as { shared: boolean }).shared, false)
  const meta = result._meta as Record<string, unknown>
  assertEquals(meta[COMPONENTS_META_KEY], {
    modules: {
      'components/chart.mdx': "import { Axis } from 'workspace:components/axis.mdx'\n\nexport const Chart = () => <Axis />\n",
      'components/axis.mdx': 'export function Axis() { return <span>axis</span> }\n',
    },
  })
  // The HTML still shows the note, for the card to show until the preview has drawn.
  assertStringIncludes(String(meta[HTML_META_KEY]), '<h1>Plan</h1>')
  assertEquals(meta[SOURCE_META_KEY], COMPONENT_NOTE)
  assertFalse(JSON.stringify(result.structuredContent).includes('export'))
})

Deno.test("show_file says when a note with components is in a project shared with the user, and who last changed their files", async () => {
  const files = [
    { ...file('notes/plan.mdx', COMPONENT_NOTE), updated_by: ME },
    { ...file('components/chart.mdx', 'export const Chart = () => null\n'), updated_by: ANA },
  ]
  const shared = await showFile('notes/plan.mdx', files, ANA)
  assertEquals((shared.result.structuredContent as { shared: boolean }).shared, true)
  const sent = (shared.result._meta as Record<string, { editors?: Record<string, string> }>)[COMPONENTS_META_KEY]
  assertEquals(sent.editors, { 'notes/plan.mdx': 'you', 'components/chart.mdx': 'Ana' })
  // The person's own project names no one.
  const own = await showFile('notes/plan.mdx', files)
  assertFalse('editors' in (own.result._meta as Record<string, Record<string, unknown>>)[COMPONENTS_META_KEY])
  // A note shown without a preview does not look the project up.
  const markdown = await showFile('notes/plan.md', [file('notes/plan.md', COMPONENT_NOTE)], 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f')
  assertFalse('shared' in (markdown.result.structuredContent as Record<string, unknown>))
})

Deno.test('show_file sends no component files for a Markdown note, a note without components, or one cut short', async () => {
  const markdown = await showFile('notes/plan.md', [file('notes/plan.md', COMPONENT_NOTE), file('components/chart.mdx', 'export const Chart = () => null\n')])
  assertEquals(markdown.queries.length, 1)
  assertFalse(COMPONENTS_META_KEY in (markdown.result._meta ?? {}))
  const plain = await showFile('notes/plain.mdx', [file('notes/plain.mdx', '# Plain\n\n<Callout>Hi</Callout>\n')])
  assertFalse(COMPONENTS_META_KEY in (plain.result._meta ?? {}))
  const long = await showFile('notes/long.mdx', [file('notes/long.mdx', COMPONENT_NOTE + 'words '.repeat(10_000))])
  assertEquals(long.queries.length, 1)
  assertFalse(COMPONENTS_META_KEY in (long.result._meta ?? {}))
})

function previewComponent(args: Record<string, unknown>, files: Row[]) {
  return withClient(files, async (client, queries) => ({
    result: (await client.callTool({ name: 'preview_component', arguments: { project_id: PROJECT, ...args } })) as CallToolResult,
    queries,
  }))
}

const CHART = "import { Axis } from 'workspace:components/axis.mdx'\n\nexport const Chart = ({ title }) => <h2>{title}<Axis /></h2>\n"

Deno.test('preview_component shows a saved component file with the files it imports, in the file view', async () => {
  await withClient([], async (client) => {
    const { tools } = await client.listTools()
    const tool = tools.find((entry) => entry.name === 'preview_component')
    assertEquals(tool?._meta, { ui: { resourceUri: FILE_VIEW_URI } })
    assertEquals(tool?.annotations?.readOnlyHint, true)
  })
  const { result, queries } = await previewComponent({ path: 'components/chart.mdx', component: 'Chart', props: { title: 'Q3' } }, [
    { ...file('components/chart.mdx', CHART), version: 3 },
    file('components/axis.mdx', 'export const Axis = () => <hr />\n'),
  ])
  assertFalse(result.isError)
  assertEquals((result.content as { text: string }[])[0].text, 'Showing a preview of Chart from components/chart.mdx (version 3) to the user.')
  assertEquals(result.structuredContent, {
    project_id: PROJECT,
    path: 'components/chart.mdx',
    kind: 'component',
    version: 3,
    updated_at: UPDATED,
    url: `https://elaborat.ing/projects/${PROJECT}/components/chart.mdx`,
    truncated: false,
    embeds: [],
    draft: false,
    component: 'Chart',
    props: { title: 'Q3' },
    shared: false,
  })
  assertEquals((result._meta as Record<string, unknown>)[COMPONENTS_META_KEY], {
    modules: { 'components/chart.mdx': CHART, 'components/axis.mdx': 'export const Axis = () => <hr />\n' },
  })
  // The file, then its import, both as the user, then whose project it is.
  assertEquals(queries.map((query) => query.find((step) => step[0] === 'eq')), [
    ['eq', 'project_id', PROJECT],
    ['eq', 'project_id', PROJECT],
    ['eq', 'id', PROJECT],
  ])
})

Deno.test('preview_component says when the component file is in a project shared with the user, and who last changed the files', async () => {
  const files = [
    { ...file('components/chart.mdx', CHART), updated_by: ANA },
    { ...file('components/axis.mdx', 'export const Axis = () => <hr />\n'), updated_by: ME },
  ]
  const { result } = await withClient(
    files,
    async (client) => ({ result: (await client.callTool({ name: 'preview_component', arguments: { project_id: PROJECT, path: 'components/chart.mdx' } })) as CallToolResult }),
    ANA,
  )
  assertEquals((result.structuredContent as { shared: boolean }).shared, true)
  const sent = (result._meta as Record<string, { editors?: Record<string, string> }>)[COMPONENTS_META_KEY]
  assertEquals(sent.editors, { 'components/chart.mdx': 'Ana', 'components/axis.mdx': 'you' })
})

Deno.test('preview_component shows a draft that is not saved, and refuses other files', async () => {
  const draft = await previewComponent({ path: 'components/new.mdx', source: CHART }, [file('components/axis.mdx', 'export const Axis = () => <hr />\n')])
  const view = draft.result.structuredContent as Record<string, unknown>
  assertEquals([view.draft, view.version, view.url, view.component, view.props], [true, null, `https://elaborat.ing/projects/${PROJECT}`, null, null])
  assertEquals((draft.result._meta as Record<string, { modules: Record<string, string> }>)[COMPONENTS_META_KEY].modules['components/new.mdx'], CHART)
  assertStringIncludes((draft.result.content as { text: string }[])[0].text, 'the components in components/new.mdx (a draft, not saved)')
  // A draft of a saved file is shown instead of the saved one.
  const over = await previewComponent({ path: 'components/chart.mdx', source: 'export const Chart = () => null\n' }, [file('components/chart.mdx', CHART)])
  assertEquals((over.result._meta as Record<string, { modules: Record<string, string> }>)[COMPONENTS_META_KEY].modules, { 'components/chart.mdx': 'export const Chart = () => null\n' })

  const missing = await previewComponent({ path: 'components/gone.mdx' }, [])
  assert(missing.result.isError)
  assertStringIncludes((missing.result.content as { text: string }[])[0].text, 'Pass source to preview a draft.')
  const notes = await previewComponent({ path: 'notes/plan.md', source: '# Plan' }, [])
  assert(notes.result.isError)
  assertEquals(notes.queries.length, 0)
})
