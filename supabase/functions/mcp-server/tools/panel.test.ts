import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_META } from './fileView.ts'
import { registerTools, type ToolContext } from './index.ts'
import { PANEL_META_KEY, PANEL_VIEW_URI } from './panel.ts'

// open_panel and its view, on a real McpServer through a real MCP client,
// with a stand-in Supabase client that answers the project's title (as RLS
// would: only for a project the person can open).

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const OTHER = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

async function withClient<T>(use: (client: Client, queries: unknown[][]) => Promise<T>, embedView = true): Promise<T> {
  const queries: unknown[][] = []
  const supabase = {
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
  })
})

Deno.test('with EMBED_VIEW_ENABLED false the tools and resources are as they were without the panel', async () => {
  const listed = (embedView: boolean) =>
    withClient(async (client) => ({
      tools: (await client.listTools()).tools,
      resources: (await client.listResources()).resources.map((resource) => resource.uri),
    }), embedView)
  const on = await listed(true)
  const off = await listed(false)
  assertEquals(off.tools.map((tool) => tool.name).sort(), on.tools.map((tool) => tool.name).filter((name) => name !== 'open_panel').sort())
  assertEquals(off.tools, on.tools.filter((tool) => tool.name !== 'open_panel'))
  assertEquals(off.resources, on.resources.filter((uri) => uri !== PANEL_VIEW_URI))
  assert(on.resources.includes(PANEL_VIEW_URI))
  assert(off.tools.every((tool) => !(tool._meta && 'openai/ui' in tool._meta)), 'no entrypoints without the panel')
})

Deno.test('with no arguments it opens the projects list, without reading anything', async () => {
  await withClient(async (client, queries) => {
    const result = await call(client, {})
    assert(!result.isError, JSON.stringify(result))
    assertEquals(text(result), 'Opened your projects beside the chat.')
    assertEquals(result.structuredContent, { url: 'https://elaborat.ing/' })
    assertEquals(result._meta, { [PANEL_META_KEY]: '/embed' })
    assertEquals(queries, [])
  })
})

Deno.test('with a project it reads its title as the user, and opens it or one of its files', async () => {
  await withClient(async (client, queries) => {
    const project = await call(client, { project_id: PROJECT })
    assert(!project.isError, JSON.stringify(project))
    assertEquals(text(project), 'Opened Launch plan beside the chat.')
    assertEquals(project.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}` })
    assertEquals(project._meta, { [PANEL_META_KEY]: `/embed/projects/${PROJECT}` })
    assertEquals(queries[0], ['from', 'projects', 'select', 'title', 'eq', 'id', PROJECT])

    const file = await call(client, { project_id: PROJECT, path: 'notes/a plan#1.mdx' })
    assertEquals(text(file), 'Opened notes/a plan#1.mdx in Launch plan beside the chat.')
    assertEquals(file.structuredContent, { url: `https://elaborat.ing/projects/${PROJECT}/notes/a%20plan%231.mdx` })
    assertEquals(file._meta, { [PANEL_META_KEY]: `/embed/projects/${PROJECT}/notes/a%20plan%231.mdx` })
  })
})

Deno.test('a project the user cannot open is an error, and so is a path without a project', async () => {
  await withClient(async (client, queries) => {
    const unknown = await call(client, { project_id: OTHER })
    assert(unknown.isError, JSON.stringify(unknown))
    assertStringIncludes(text(unknown), 'list_projects')

    const before = queries.length
    for (const args of [{ path: 'notes/a.mdx' }, { project_id: 'not-a-uuid' }, { project_id: PROJECT, path: '' }]) {
      const result = await call(client, args)
      assert(result.isError, `accepted ${JSON.stringify(args)}`)
    }
    assertEquals(queries.length, before, 'invalid input never reaches Supabase')
  })
})
