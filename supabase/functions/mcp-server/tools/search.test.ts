import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { registerTools, type ToolContext } from './index.ts'

// The search tool on a real McpServer through a real MCP client, with a
// stand-in Supabase client and embedding model.

const passage = {
  passage_id: 1,
  project_id: '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e',
  file_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  path: 'notes/sauce.md',
  headings: 'Sauce',
  content: 'Slow simmered tomato sauce.',
  start_offset: 0,
  end_offset: 30,
  score: 0.03,
}

async function search(args: Record<string, unknown>, answer: { data: unknown; error: unknown }) {
  const rpcs: Array<{ name: string; args: unknown }> = []
  const embedded: string[] = []
  const supabase = {
    rpc(name: string, rpcArgs: unknown) {
      rpcs.push({ name, args: rpcArgs })
      return Promise.resolve(answer)
    },
  } as unknown as SupabaseClient
  const context = {
    supabase,
    userClaims: { id: 'u', email: 'ada@example.com', role: 'authenticated' },
    jwtClaims: { sub: 'u', client_id: 'claude' },
    embed: async (text: string) => {
      embedded.push(text)
      return [0.25, -0.25]
    },
  } as unknown as ToolContext
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, context)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const result = (await client.callTool({ name: 'search', arguments: args })) as CallToolResult
    return { result, rpcs, embedded }
  } finally {
    await client.close()
    await server.close()
  }
}

Deno.test('search embeds the query and runs hybrid_search as the user', async () => {
  const { result, rpcs, embedded } = await search({ query: 'tomato sauce', match_count: 5 }, { data: [passage], error: null })
  assertEquals(result.isError, undefined)
  assertEquals(result.structuredContent, { passages: [passage] })
  assertEquals(embedded, ['tomato sauce'])
  assertEquals(rpcs, [{ name: 'hybrid_search', args: { query_text: 'tomato sauce', query_embedding: '[0.25,-0.25]', match_count: 5 } }])
})

Deno.test('search returns 10 passages unless asked for another count, up to 30', async () => {
  const { rpcs } = await search({ query: 'basil' }, { data: [], error: null })
  assertEquals((rpcs[0].args as { match_count: number }).match_count, 10)
  const tooMany = await search({ query: 'basil', match_count: 31 }, { data: [], error: null })
  assertEquals([tooMany.result.isError, tooMany.rpcs.length], [true, 0])
})

Deno.test('a database error comes back as a tool error', async () => {
  const { result } = await search({ query: 'tomato' }, { data: null, error: { message: 'permission denied for function hybrid_search' } })
  assertEquals(result.isError, true)
})
