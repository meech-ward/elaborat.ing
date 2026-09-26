import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import {
  type CallToolResult,
  InMemoryTransport,
  McpServer,
} from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { registerTools, type ToolContext } from './index.ts'

// The tools run on a real McpServer and are called through a real MCP client,
// so input validation happens exactly as it does for Claude or ChatGPT. The
// Supabase client is a stand-in that records every call and answers with
// canned results.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const MEMBER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const MUTATION = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Answer = { data: unknown; error: unknown }
type Call = { rpc: string; args?: unknown } | { table: string; query: unknown[][] }

/**
 * Records calls and answers each rpc or table with `answers[name]`, or throws
 * `failure`. Unanswered queries get what supabase-js gives for no rows.
 */
function fakeSupabase(answers: Record<string, Answer>, failure?: Error) {
  const calls: Call[] = []
  const answer = (name: string, empty: unknown = null) =>
    failure ? Promise.reject(failure) : Promise.resolve(answers[name] ?? { data: empty, error: null })
  const supabase = {
    rpc(name: string, args?: Record<string, unknown>) {
      // What goes over the wire: JSON drops keys whose value is undefined.
      calls.push(args === undefined ? { rpc: name } : { rpc: name, args: JSON.parse(JSON.stringify(args)) })
      return answer(name)
    },
    from(table: string) {
      const query: unknown[][] = []
      calls.push({ table, query })
      const builder = {
        select: (...args: unknown[]) => (query.push(['select', ...args]), builder),
        eq: (...args: unknown[]) => (query.push(['eq', ...args]), builder),
        order: (...args: unknown[]) => (query.push(['order', ...args]), builder),
        maybeSingle: () => (query.push(['maybeSingle']), answer(table)),
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
          answer(table, []).then(resolve, reject),
      }
      return builder
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, calls }
}

/** Calls one tool on a fresh server and returns its result with the Supabase calls it made. */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  answers: Record<string, Answer> = {},
  failure?: Error,
): Promise<{ result: CallToolResult; calls: Call[] }> {
  const { supabase, calls } = fakeSupabase(answers, failure)
  const context = {
    supabase,
    userClaims: { id: MEMBER, email: 'ada@example.com', role: 'authenticated' },
    jwtClaims: { sub: MEMBER, client_id: 'claude' },
  } as unknown as ToolContext
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, context)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return { result: (await client.callTool({ name, arguments: args })) as CallToolResult, calls }
  } finally {
    await client.close()
    await server.close()
  }
}

function errorText(result: CallToolResult): string {
  assert(result.isError, `expected an error result, got ${JSON.stringify(result)}`)
  const [content] = result.content
  return content.type === 'text' ? content.text : ''
}

// Every tool, valid arguments for it, the Supabase calls it must make, and
// answers for the calls that need one.
const CASES: [string, Record<string, unknown>, Call[], Record<string, Answer>?][] = [
  ['whoami', {}, []],
  ['list_projects', {}, [{ rpc: 'list_projects' }]],
  ['list_invitations', {}, [{ rpc: 'list_invitations' }]],
  [
    'list_files',
    { project_id: PROJECT },
    [
      {
        table: 'project_files',
        query: [['select', 'path, version, updated_at'], ['eq', 'project_id', PROJECT], ['order', 'path']],
      },
      { table: 'project_folders', query: [['select', 'path'], ['eq', 'project_id', PROJECT], ['order', 'path']] },
    ],
  ],
  [
    'read_file',
    { project_id: PROJECT, path: 'notes/plan.md' },
    [
      {
        table: 'project_files',
        query: [
          ['select', 'path, content, version, updated_at'],
          ['eq', 'project_id', PROJECT],
          ['eq', 'path', 'notes/plan.md'],
          ['maybeSingle'],
        ],
      },
    ],
    { project_files: { data: { path: 'notes/plan.md', content: '# Plan', version: 3 }, error: null } },
  ],
  ['rename_project', { project_id: PROJECT, title: 'Plans' }, [
    { rpc: 'rename_project', args: { project_id: PROJECT, title: 'Plans' } },
  ]],
  [
    'write_file',
    { project_id: PROJECT, path: 'notes/plan.md', content: '# Plan', base_version: 3, mutation_id: MUTATION },
    [{
      rpc: 'save_files',
      args: {
        project_id: PROJECT,
        mutation_id: MUTATION,
        changes: [{ op: 'put', path: 'notes/plan.md', content: '# Plan', base_version: 3 }],
      },
    }],
  ],
  [
    'save_files',
    {
      project_id: PROJECT,
      mutation_id: MUTATION,
      changes: [
        { op: 'put', path: 'a.d2', content: 'x -> y' },
        { op: 'delete', path: 'b.md', base_version: 2 },
        { op: 'move', path: 'c.md', to: 'd.md', base_version: 5 },
        { op: 'mkdir', path: 'drafts' },
        { op: 'rmdir', path: 'old' },
      ],
    },
    [{
      rpc: 'save_files',
      args: {
        project_id: PROJECT,
        mutation_id: MUTATION,
        changes: [
          { op: 'put', path: 'a.d2', content: 'x -> y' },
          { op: 'delete', path: 'b.md', base_version: 2 },
          { op: 'move', path: 'c.md', to: 'd.md', base_version: 5 },
          { op: 'mkdir', path: 'drafts' },
          { op: 'rmdir', path: 'old' },
        ],
      },
    }],
  ],
  [
    'move_file',
    { project_id: PROJECT, path: 'c.md', to: 'd.md', base_version: 5, mutation_id: MUTATION },
    [{
      rpc: 'save_files',
      args: {
        project_id: PROJECT,
        mutation_id: MUTATION,
        changes: [{ op: 'move', path: 'c.md', to: 'd.md', base_version: 5 }],
      },
    }],
  ],
  [
    'delete_file',
    { project_id: PROJECT, path: 'b.md', base_version: 2, mutation_id: MUTATION },
    [{
      rpc: 'save_files',
      args: { project_id: PROJECT, mutation_id: MUTATION, changes: [{ op: 'delete', path: 'b.md', base_version: 2 }] },
    }],
  ],
  [
    'create_folder',
    { project_id: PROJECT, path: 'drafts', mutation_id: MUTATION },
    [{
      rpc: 'save_files',
      args: { project_id: PROJECT, mutation_id: MUTATION, changes: [{ op: 'mkdir', path: 'drafts' }] },
    }],
  ],
  ['archive_project', { project_id: PROJECT }, [{ rpc: 'archive_project', args: { project_id: PROJECT } }]],
  ['unarchive_project', { project_id: PROJECT }, [{ rpc: 'unarchive_project', args: { project_id: PROJECT } }]],
  [
    'share_project',
    { project_id: PROJECT, member_id: MEMBER, role: 'editor' },
    [{ rpc: 'share_project', args: { project_id: PROJECT, member_id: MEMBER, member_role: 'editor' } }],
  ],
  ['leave_project', { project_id: PROJECT }, [{ rpc: 'leave_project', args: { project_id: PROJECT } }]],
]

Deno.test('the tests cover every tool the server lists', async () => {
  const { supabase } = fakeSupabase({})
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase } as unknown as ToolContext)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    // search is tested in search.test.ts.
    const tested = [...CASES.map(([name]) => name), 'create_project', 'search'].sort()
    assertEquals(tools.map((tool) => tool.name).sort(), tested)
  } finally {
    await client.close()
    await server.close()
  }
})

for (const [name, args, expected, answers] of CASES) {
  Deno.test(`${name} makes the right Supabase calls`, async () => {
    const { result, calls } = await callTool(name, args, answers)
    assert(!result.isError, JSON.stringify(result))
    assertEquals(calls, expected)
  })
}

Deno.test('create_project sends a new project id and the title', async () => {
  const { result, calls } = await callTool('create_project', { title: 'Plans' })
  assert(!result.isError, JSON.stringify(result))
  assertEquals(calls.length, 1)
  const [call] = calls
  assert('rpc' in call && call.rpc === 'create_project')
  const { project_id, ...rest } = call.args as Record<string, unknown>
  assertMatch(String(project_id), UUID)
  assertEquals(rest, { title: 'Plans' })
})

Deno.test('write_file without base_version sends a create', async () => {
  const { calls } = await callTool('write_file', { project_id: PROJECT, path: 'new.md', content: 'Hello' })
  const [call] = calls
  assert('rpc' in call && call.rpc === 'save_files')
  const { mutation_id, ...rest } = call.args as Record<string, unknown>
  // With no mutation_id, the tool makes one up, so a retry by the client is a new change.
  assertMatch(String(mutation_id), UUID)
  assertEquals(rest, { project_id: PROJECT, changes: [{ op: 'put', path: 'new.md', content: 'Hello' }] })
})

Deno.test('share_project with role null removes the member', async () => {
  const { calls } = await callTool('share_project', { project_id: PROJECT, member_id: MEMBER, role: null })
  assertEquals(calls, [{ rpc: 'share_project', args: { project_id: PROJECT, member_id: MEMBER, member_role: null } }])
})

Deno.test('list_projects and list_invitations wrap their arrays', async () => {
  const projects = [{ id: PROJECT, title: 'Plans', revision: 4, archived_at: null, role: 'owner' }]
  const listed = await callTool('list_projects', {}, { list_projects: { data: projects, error: null } })
  assertEquals(listed.result.structuredContent, { projects })

  const invitations = [{ project_id: PROJECT, title: 'Shared', role: 'viewer' }]
  const invited = await callTool('list_invitations', {}, { list_invitations: { data: invitations, error: null } })
  assertEquals(invited.result.structuredContent, { invitations })
})

Deno.test('list_files and read_file return what the queries find', async () => {
  const files = [{ path: 'a.md', version: 2, updated_at: '2026-09-26T00:00:00Z' }]
  const listed = await callTool('list_files', { project_id: PROJECT }, {
    project_files: { data: files, error: null },
    project_folders: { data: [{ path: 'drafts' }], error: null },
  })
  assertEquals(listed.result.structuredContent, { files, folders: ['drafts'] })

  const file = { path: 'a.md', content: '# A', version: 2, updated_at: '2026-09-26T00:00:00Z' }
  const read = await callTool('read_file', { project_id: PROJECT, path: 'a.md' }, {
    project_files: { data: file, error: null },
  })
  assertEquals(read.result.structuredContent, file)

  const missing = await callTool('read_file', { project_id: PROJECT, path: 'nope.md' })
  assertEquals(errorText(missing.result), 'No file at nope.md in this project. Use list_files to see what exists.')
})

Deno.test('Supabase errors come back as readable error results', async () => {
  const error = { code: '42501', message: 'Project unavailable', hint: 'Check the project id.', details: null }

  const rpc = await callTool('archive_project', { project_id: PROJECT }, { archive_project: { data: null, error } })
  assertEquals(errorText(rpc.result), '[42501] Project unavailable Hint: Check the project id.')

  const query = await callTool('read_file', { project_id: PROJECT, path: 'a.md' }, {
    project_files: { data: null, error: { code: 'PGRST301', message: 'JWT expired', hint: null, details: null } },
  })
  assertEquals(errorText(query.result), '[PGRST301] JWT expired')

  const thrown = await callTool('list_projects', {}, {}, new TypeError('fetch failed'))
  assertEquals(errorText(thrown.result), 'fetch failed')
})

Deno.test('invalid input is rejected before any Supabase call', async () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['archive_project', { project_id: 'not-a-uuid' }],
    ['read_file', { project_id: PROJECT, path: '' }],
    ['write_file', { project_id: PROJECT, path: 'a.md', content: 'x', base_version: 0 }],
    ['save_files', { project_id: PROJECT, changes: [{ op: 'chmod', path: 'a.md' }] }],
    ['save_files', { project_id: PROJECT, changes: [] }],
    ['share_project', { project_id: PROJECT, member_id: MEMBER, role: 'owner' }],
  ]
  for (const [name, args] of invalid) {
    const { result, calls } = await callTool(name, args)
    assert(result.isError, `${name} accepted ${JSON.stringify(args)}`)
    assertEquals(calls, [], `${name} called Supabase with ${JSON.stringify(args)}`)
  }
})

Deno.test('no tool permanently deletes a project or accepts an invitation', async () => {
  const forbidden = ['delete_project', 'accept_invitation']
  for (const [name, args, , answers] of CASES) {
    assert(!forbidden.includes(name), `${name} is a tool`)
    const { calls } = await callTool(name, args, answers)
    for (const call of calls) {
      assert(!('rpc' in call && forbidden.includes(call.rpc)), `${name} calls ${JSON.stringify(call)}`)
    }
  }
})
