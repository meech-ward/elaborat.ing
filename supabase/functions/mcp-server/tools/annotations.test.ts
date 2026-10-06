import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { FILE_VIEW_URI } from './fileView.ts'
import { registerTools, type ToolContext } from './index.ts'
import { profileName } from './whoami.ts'

// What every tool tells a client about itself before it is called, and the
// account profile. Every tool states all three hints as booleans; a tool that
// changes or removes anything (a file, a title, a thread's state, who has
// access) is destructive, whether or not it can be undone; only tools that
// add something are not; and no tool reaches outside the person's own account.

/** The tools that change or remove data or access. */
const DESTRUCTIVE = [
  'archive_project',
  'delete_file',
  'leave_project',
  'move_file',
  'rename_project',
  'resolve_comment',
  'save_files',
  'share_project',
  'unarchive_project',
  'write_file',
]

async function withClient<T>(context: Partial<ToolContext>, run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase: {} as SupabaseClient, ...context } as ToolContext)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

Deno.test('every tool states whether it reads, destroys and reaches outside the account', async () => {
  const tools = await withClient({}, async (client) => (await client.listTools()).tools)
  assert(tools.length > 0)
  for (const tool of tools) {
    const hints = tool.annotations ?? {}
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
      assertEquals(typeof hints[hint], 'boolean', `${tool.name} has no ${hint}`)
    }
    assertEquals(hints.openWorldHint, false, `${tool.name} reaches outside the account`)
    assertEquals(hints.destructiveHint, DESTRUCTIVE.includes(tool.name), `${tool.name}'s destructiveHint`)
    if (hints.readOnlyHint) assertEquals(hints.destructiveHint, false, `${tool.name} reads only, yet destroys`)
  }
  for (const name of DESTRUCTIVE) assert(tools.some((tool) => tool.name === name), `${name} is not a tool`)
  // open_panel only shows the app beside the chat. The pass it mints for its
  // view is a short-lived row of the server's own, not the person's data, so
  // it stays read-only: a host may ask before running a tool that is not.
  const panel = tools.find((tool) => tool.name === 'open_panel')
  assertEquals(panel?.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
  // create_and_show only adds a file: the database refuses it where one exists. Its view is the file view.
  const create = tools.find((tool) => tool.name === 'create_and_show')
  assertEquals(create?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  assertEquals(create?._meta, { ui: { resourceUri: FILE_VIEW_URI, visibility: ['model'] } })
  // panel_pass adds a short-lived pass for the panel's view, and changes nothing of the person's.
  const pass = tools.find((tool) => tool.name === 'panel_pass')
  assertEquals(pass?.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false })
})

Deno.test('whoami is the account profile: exactly id, name and email, as structured content and JSON text', async () => {
  const context = {
    userClaims: {
      id: 'b7c1e0a2-3d4f-4a5b-8c6d-7e8f9a0b1c2d',
      email: 'ada@example.com',
      role: 'authenticated',
      userMetadata: { display_name: '  Ada   Lovelace ', full_name: 'Augusta Ada King' },
    },
    jwtClaims: { sub: 'b7c1e0a2-3d4f-4a5b-8c6d-7e8f9a0b1c2d', client_id: 'chatgpt' },
  } as unknown as ToolContext
  await withClient(context, async (client) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'whoami')
    assertEquals(tool?._meta, { 'openai/profile': true })
    assertEquals(tool?.annotations?.readOnlyHint, true)
    assertEquals(tool?.inputSchema.properties ?? {}, {})
    assertEquals(tool?.outputSchema?.additionalProperties, false)
    assertEquals(Object.keys(tool?.outputSchema?.properties ?? {}).sort(), ['email', 'id', 'name', 'nickname'])
    assertEquals(tool?.outputSchema?.required, ['id'])

    const result = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult
    const profile = { id: 'b7c1e0a2-3d4f-4a5b-8c6d-7e8f9a0b1c2d', name: 'Ada Lovelace', email: 'ada@example.com' }
    assertEquals(result.structuredContent, profile)
    assertEquals(result.content, [{ type: 'text', text: JSON.stringify(profile) }])
  })
})

Deno.test("an account with no name or email has a profile of its id alone", async () => {
  const context = { userClaims: { id: 'b7c1e0a2-3d4f-4a5b-8c6d-7e8f9a0b1c2d' }, jwtClaims: {} } as unknown as ToolContext
  await withClient(context, async (client) => {
    const result = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult
    assertEquals(result.structuredContent, { id: 'b7c1e0a2-3d4f-4a5b-8c6d-7e8f9a0b1c2d' })
  })
  assertEquals(profileName({ display_name: ' ', full_name: 42, name: 'Grace' }), 'Grace')
  assertEquals(profileName({ display_name: 'x'.repeat(90) }), 'x'.repeat(80))
  assertEquals(profileName(undefined), undefined)
})
