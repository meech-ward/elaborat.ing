import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { registerTools, type ToolContext } from './index.ts'
import { limitToolCalls } from './limits.ts'

// The server wraps every tool so that a call first counts against the user's
// limit in the database. The Supabase client is a stand-in that records rpc
// names and answers each with `answers[name]`.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const LIMITED = {
  data: null,
  error: {
    code: 'PT429',
    message: 'You have reached the limit of 300 agent tool calls a minute. Try again in 42 seconds.',
    details: 'tool_calls_per_minute',
    hint: null,
  },
}

type Answer = { data: unknown; error: unknown }

async function callTool(name: string, args: Record<string, unknown>, answers: Record<string, Answer> = {}) {
  const rpcs: string[] = []
  const supabase = {
    rpc(rpcName: string) {
      rpcs.push(rpcName)
      return Promise.resolve(answers[rpcName] ?? { data: null, error: null })
    },
  } as unknown as SupabaseClient
  const context = { supabase, userClaims: { id: 'user' }, jwtClaims: {} } as unknown as ToolContext
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  limitToolCalls(server, context)
  registerTools(server, context)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return { result: (await client.callTool({ name, arguments: args })) as CallToolResult, rpcs }
  } finally {
    await client.close()
    await server.close()
  }
}

const text = (result: CallToolResult) => {
  const [content] = result.content
  return content.type === 'text' ? content.text : ''
}

Deno.test('a tool call is counted before the tool runs', async () => {
  const { result, rpcs } = await callTool('list_projects', {}, { list_projects: { data: [], error: null } })
  assert(!result.isError, JSON.stringify(result))
  assertEquals(rpcs, ['count_tool_call', 'list_projects'])
})

Deno.test('over the limit, the tool does not run and the message comes back as is', async () => {
  const { result, rpcs } = await callTool('list_projects', {}, { count_tool_call: LIMITED })
  assertEquals(result.isError, true)
  assertEquals(text(result), LIMITED.error.message)
  assertEquals(rpcs, ['count_tool_call'])
})

Deno.test('when counting fails for another reason, the tool still runs', async () => {
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function', details: null, hint: null } }
  const { result, rpcs } = await callTool('list_projects', {}, { count_tool_call: missing, list_projects: { data: [], error: null } })
  assert(!result.isError, JSON.stringify(result))
  assertEquals(rpcs, ['count_tool_call', 'list_projects'])
})

Deno.test('a call with invalid arguments is refused before it is counted', async () => {
  const { result, rpcs } = await callTool('list_members', { project_id: 'not an id' })
  assertEquals(result.isError, true)
  assertEquals(rpcs, [])
})

Deno.test("a limit reached inside a tool, such as saves a minute, comes back as is", async () => {
  const saves = { ...LIMITED, error: { ...LIMITED.error, message: 'You have reached the limit of 300 saves a minute. Try again in 5 seconds.' } }
  const { result } = await callTool('write_file', { project_id: PROJECT, path: 'a.md', content: 'x' }, { save_files: saves })
  assertEquals(result.isError, true)
  assertEquals(text(result), saves.error.message)
})
