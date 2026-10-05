import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_META } from './fileView.ts'
import { registerTools, type ToolContext } from './index.ts'
import { PANEL_META_KEY, PANEL_PASS_KEY, PANEL_VIEW_URI } from './panel.ts'

// open_panel, panel_pass and the view, on a real McpServer through a real MCP
// client, with a stand-in Supabase client that answers the project's title
// (as RLS would: only for a project the person can open) and mints a new
// pass for each call of mint_panel_pass (or fails, with `mintFails`).

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const OTHER = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

async function withClient<T>(use: (client: Client, queries: unknown[][]) => Promise<T>, embedView = true, mintFails = false): Promise<T> {
  const queries: unknown[][] = []
  let minted = 0
  const supabase = {
    rpc(name: string, ...args: unknown[]) {
      queries.push(['rpc', name, ...args])
      if (mintFails) return Promise.resolve({ data: null, error: { message: 'database unavailable' } })
      return Promise.resolve({ data: name === 'mint_panel_pass' ? (++minted).toString(16).padStart(64, 'a') : null, error: null })
    },
    from(table: string) {
      const query: unknown[] = ['from', table]
      queries.push(query)
      const builder = {
        select: (...args: unknown[]) => (query.push('select', ...args), builder),
        eq: (...args: unknown[]) => (query.push('eq', ...args), builder),
        maybeSingle: () => Promise.resolve({ data: query.includes(PROJECT) ? { title: 'Launch plan' } : null, error: null }),
      }
      return builder
    },
  } as unknown as SupabaseClient
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase, userClaims: { id: 'me' } } as unknown as ToolContext, { embedView })
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

const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'open_panel', arguments: args }) as Promise<CallToolResult>
const text = (result: CallToolResult) => (result.content[0]?.type === 'text' ? result.content[0].text : '')

Deno.test('open_panel opens from the sidebar and a conversation panel, and its view may frame only the app', async () => {
  await withClient(async (client) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'open_panel')
    assert(tool, 'open_panel is listed')
    assertEquals(tool.title, 'Projects')
    assertEquals(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assertEquals(tool._meta, {
      ui: { resourceUri: PANEL_VIEW_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
      'openai/widgetAccessible': true,
    })
    const [icon] = tool.icons ?? []
    assertEquals(icon?.mimeType, 'image/svg+xml')
    const svg = atob(String(icon?.src).replace('data:image/svg+xml;base64,', ''))
    assertStringIncludes(svg, 'viewBox="0 0 20 20"')
    assertStringIncludes(svg, 'stroke="currentColor"')

    const { contents } = await client.readResource({ uri: PANEL_VIEW_URI })
    const [view] = contents as { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> & { ui: Record<string, unknown> } }[]
    assertEquals(view.mimeType, 'text/html;profile=mcp-app')
    assertEquals(view._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: ['https://elaborat.ing'] })
    assertEquals(view._meta['openai/widgetCSP'], {
      connect_domains: [],
      resource_domains: [],
      frame_domains: ['https://elaborat.ing'],
      redirect_domains: ['https://elaborat.ing'],
    })
    // One widget origin for the card and the panel, so the site allows one view origin per chat.
    assertEquals(view._meta['openai/widgetDomain'], FILE_VIEW_META['openai/widgetDomain'])
    assertStringIncludes(view.text, "elaborat.ing can't open in this panel.")
    // The view puts each page's pass in its fragment, never its query, and asks panel_pass for a new one.
    assertStringIncludes(view.text, '"#pass=" + pass')
    assertStringIncludes(view.text, 'callTool("panel_pass", {})')
    assert(!/[?&]pass=/.test(view.text), 'no pass in a query string')
  })
})

Deno.test('panel_pass is for the view only, and gives it a new pass in _meta alone', async () => {
  await withClient(async (client, queries) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'panel_pass')
    assert(tool, 'panel_pass is listed')
    assertEquals(tool._meta, { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true })
    // It adds a short-lived row, and changes nothing of the person's.
    assertEquals(tool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false })

    const first = (await client.callTool({ name: 'panel_pass', arguments: {} })) as CallToolResult
    const second = (await client.callTool({ name: 'panel_pass', arguments: {} })) as CallToolResult
    assert(!first.isError, JSON.stringify(first))
    const pass = first._meta?.[PANEL_PASS_KEY]
    assertMatch(String(pass), /^[0-9a-f]{64}$/)
    assert(second._meta?.[PANEL_PASS_KEY] !== pass, 'each call mints a new pass')
    assertEquals(first.structuredContent, undefined)
    assertEquals(text(first), 'A new pass for the panel.')
    assertEquals(queries, [['rpc', 'mint_panel_pass'], ['rpc', 'mint_panel_pass']])
  })
})

Deno.test('without a pass, open_panel and panel_pass are errors', async () => {
  await withClient(async (client) => {
    for (const name of ['open_panel', 'panel_pass']) {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult
      assert(result.isError, JSON.stringify(result))
      assertEquals(result._meta?.[PANEL_PASS_KEY], undefined)
    }
  }, true, true)
})

Deno.test('with EMBED_VIEW_ENABLED false the tools and resources are as they were without the panel', async () => {
  const listed = (embedView: boolean) =>
    withClient(async (client) => ({
      tools: (await client.listTools()).tools,
      resources: (await client.listResources()).resources.map((resource) => resource.uri),
    }), embedView)
  const on = await listed(true)
  const off = await listed(false)
  const panelTools = ['open_panel', 'panel_pass']
  assertEquals(off.tools.map((tool) => tool.name).sort(), on.tools.map((tool) => tool.name).filter((name) => !panelTools.includes(name)).sort())
  assertEquals(off.tools, on.tools.filter((tool) => !panelTools.includes(tool.name)))
  assertEquals(off.resources, on.resources.filter((uri) => uri !== PANEL_VIEW_URI))
  assert(on.resources.includes(PANEL_VIEW_URI))
  assert(off.tools.every((tool) => !(tool._meta && 'openai/ui' in tool._meta)), 'no entrypoints without the panel')
})

Deno.test('with no arguments it opens the projects list, reading nothing, with a pass for the view alone', async () => {
  await withClient(async (client, queries) => {
    const result = await call(client, {})
    assert(!result.isError, JSON.stringify(result))
    assertEquals(text(result), 'Opened your projects beside the chat.')
    assertEquals(result.structuredContent, { url: 'https://elaborat.ing/' })
    const pass = String(result._meta?.[PANEL_PASS_KEY])
    assertMatch(pass, /^[0-9a-f]{64}$/)
    assertEquals(result._meta, { [PANEL_META_KEY]: '/embed', [PANEL_PASS_KEY]: pass })
    // What the model sees never holds it.
    assert(!JSON.stringify([result.content, result.structuredContent]).includes(pass))
    assertEquals(queries, [['rpc', 'mint_panel_pass']])
  })
})

Deno.test('with a project it reads its title as the user, and opens it or one of its files', async () => {
  await withClient(async (client, queries) => {
    const project = await call(client, { project_id: PROJECT })
    assert(!project.isError, JSON.stringify(project))
    assertEquals(text(project), 'Opened Launch plan beside the chat.')
    assertEquals(project.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}` })
    assertEquals(project._meta?.[PANEL_META_KEY], `/embed/projects/${PROJECT}`)
    assertMatch(String(project._meta?.[PANEL_PASS_KEY]), /^[0-9a-f]{64}$/)
    assertEquals(queries[0], ['from', 'projects', 'select', 'title', 'eq', 'id', PROJECT])

    const file = await call(client, { project_id: PROJECT, path: 'notes/a plan#1.mdx' })
    assertEquals(text(file), 'Opened notes/a plan#1.mdx in Launch plan beside the chat.')
    assertEquals(file.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}/notes/a%20plan%231.mdx` })
    assertEquals(file._meta?.[PANEL_META_KEY], `/embed/projects/${PROJECT}/notes/a%20plan%231.mdx`)
    assert(file._meta?.[PANEL_PASS_KEY] !== project._meta?.[PANEL_PASS_KEY], 'each result has a new pass')
  })
})

Deno.test('a project the user cannot open is an error, and so is a path without a project', async () => {
  await withClient(async (client, queries) => {
    const unknown = await call(client, { project_id: OTHER })
    assert(unknown.isError, JSON.stringify(unknown))
    assertStringIncludes(text(unknown), 'list_projects')
    assertEquals(unknown._meta, undefined, 'no pass for a project the user cannot open')

    const before = queries.length
    for (const args of [{ path: 'notes/a.mdx' }, { project_id: 'not-a-uuid' }, { project_id: PROJECT, path: '' }]) {
      const result = await call(client, args)
      assert(result.isError, `accepted ${JSON.stringify(args)}`)
    }
    assertEquals(queries.length, before, 'invalid input never reaches Supabase')
  })
})
