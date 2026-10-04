import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { describeRange } from '../../_shared/comments/anchoring.ts'
import { registerTools, type ToolContext } from './index.ts'

// The comment tools on a real McpServer, called through a real MCP client.
// The Supabase client is a stand-in: it answers file reads from a list of
// files and each database function from a canned answer, and records every call.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const THREAD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TIME = '2026-09-27T00:00:00Z'

type Row = { id: string; path: string; content: string; version: number }
type Answer = { data: unknown; error: unknown }
type Call = { rpc: string; args?: Record<string, unknown> } | { table: string; query: unknown[][] }

const NOTE = [
  '# Guide',
  '',
  'Intro text.',
  '',
  '## Setup',
  '',
  'Install the tools. Then install the tools again.',
  '',
  '## Use',
  '',
  '### Setup',
  '',
  'More.',
  '',
].join('\n')

const DRAWING = JSON.stringify({
  type: 'excalidraw',
  elements: [
    { id: 'box', type: 'rectangle', x: 0, y: 0 },
    { id: 'box-label', type: 'text', text: 'Start', originalText: 'Start', containerId: 'box', x: 0, y: 0 },
    { id: 'circle', type: 'ellipse', x: 50, y: 0 },
    { id: 'gone', type: 'diamond', x: 90, y: 0, isDeleted: true },
  ],
})

const FILES: Row[] = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', path: 'notes/guide.md', content: NOTE, version: 4 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', path: 'sketch.excalidraw', content: DRAWING, version: 2 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', path: 'flow.d2', content: 'a -> b', version: 3 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000004', path: 'notes/plain.md', content: 'No headings here.', version: 1 },
]

const person = (email: string, name?: string) => ({ user_id: '11111111-1111-4111-8111-111111111111', email, ...(name ? { name } : {}) })

function comment(body: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    author: person('ada@example.com', 'Ada Lovelace'),
    via_agent: false,
    body,
    created_at: TIME,
    edited_at: null,
    deleted_at: null,
    ...extra,
  }
}

/** A thread as the database lists it, on the note unless `extra` says otherwise. */
function thread(anchor: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: THREAD,
    file_id: FILES[0].id,
    path: FILES[0].path,
    file_deleted: false,
    file_version: 4,
    anchor,
    created_at: TIME,
    resolved_at: null,
    resolved_by: null,
    comments: [comment('Is this right?')],
    ...extra,
  }
}

/** A text or section anchor for the first occurrence of `text` in NOTE, as the app describes it. */
function noteAnchor(kind: 'text' | 'section', text: string) {
  const start = NOTE.indexOf(text)
  const [quote, position] = describeRange(NOTE, start, start + text.length)
  return { kind, quote, position }
}

/** add_comment answers with the thread the arguments describe. */
const addAnswer = (args: Record<string, unknown>): Answer => ({
  data: {
    revision: 9,
    thread: thread(args.anchor, {
      id: args.thread_id,
      file_id: args.file_id,
      path: FILES.find((file) => file.id === args.file_id)?.path,
      file_version: args.file_version,
      comments: [comment(String(args.body), { via_agent: true, agent: 'Claude' })],
    }),
  },
  error: null,
})

async function callTool(
  name: string,
  args: Record<string, unknown>,
  answers: Record<string, (args: Record<string, unknown>) => Answer> = {},
): Promise<{ result: CallToolResult; calls: Call[] }> {
  const calls: Call[] = []
  const supabase = {
    rpc(rpc: string, rpcArgs: Record<string, unknown>) {
      calls.push({ rpc, args: JSON.parse(JSON.stringify(rpcArgs)) })
      return Promise.resolve(answers[rpc]?.(rpcArgs) ?? { data: null, error: null })
    },
    from(table: string) {
      const query: unknown[][] = []
      calls.push({ table, query })
      const builder = {
        select: (...rest: unknown[]) => (query.push(['select', ...rest]), builder),
        eq: (...rest: unknown[]) => (query.push(['eq', ...rest]), builder),
        maybeSingle: () => {
          query.push(['maybeSingle'])
          const wanted = query.find((part) => part[0] === 'eq' && part[1] === 'path')?.[2]
          return Promise.resolve({ data: FILES.find((file) => file.path === wanted) ?? null, error: null })
        },
      }
      return builder
    },
  }
  const context = {
    supabase: supabase as unknown as SupabaseClient,
    userClaims: { id: 'user', email: 'ada@example.com', role: 'authenticated' },
    jwtClaims: { sub: 'user', client_id: 'claude' },
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

const readQuery = (path: string): Call => ({
  table: 'project_files',
  query: [['select', 'id, path, content, version'], ['eq', 'project_id', PROJECT], ['eq', 'path', path], ['maybeSingle']],
})

const rpcCalls = (calls: Call[]) => calls.filter((call): call is { rpc: string; args: Record<string, unknown> } => 'rpc' in call)

/** Calls add_comment and returns the anchor it sent, after checking the rest of the call. */
async function addedAnchor(args: Record<string, unknown>): Promise<unknown> {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, body: 'Look', ...args }, { add_comment: addAnswer })
  assert(!result.isError, JSON.stringify(result))
  const file = FILES.find((row) => row.path === args.path)!
  assertEquals(calls[0], readQuery(file.path))
  const [call] = rpcCalls(calls)
  assertEquals(call.rpc, 'add_comment')
  const { thread_id, anchor, ...rest } = call.args
  assertMatch(String(thread_id), UUID)
  assertEquals(rest, { project_id: PROJECT, file_id: file.id, file_version: file.version, body: 'Look' })
  return anchor
}

// add_comment: quotes.

Deno.test('add_comment anchors a unique quote with the app selectors', async () => {
  assertEquals(await addedAnchor({ path: 'notes/guide.md', quote: 'Intro text' }), noteAnchor('text', 'Intro text'))
})

Deno.test('add_comment refuses a quote that is not in the file', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', quote: 'Outro' })
  assertEquals(
    errorText(result),
    "That quote is not in notes/guide.md. Copy it exactly from the file's source, as read_file returns it, Markdown included."
  )
  assertEquals(rpcCalls(calls), [])
})

Deno.test('add_comment refuses a quote found twice', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', quote: 'the tools' })
  assertEquals(
    errorText(result),
    'That quote appears 2 times in notes/guide.md. Add prefix or suffix, the text right before or after it, to pick one.'
  )
  assertEquals(rpcCalls(calls), [])
})

Deno.test('a prefix or a suffix picks one occurrence, with the full context stored', async () => {
  const first = NOTE.indexOf('the tools')
  const second = NOTE.indexOf('the tools', first + 1)
  const [firstQuote, firstPosition] = describeRange(NOTE, first, first + 9)
  const [secondQuote, secondPosition] = describeRange(NOTE, second, second + 9)
  assertEquals(
    await addedAnchor({ path: 'notes/guide.md', quote: 'the tools', prefix: 'Install ' }),
    { kind: 'text', quote: firstQuote, position: firstPosition }
  )
  assertEquals(
    await addedAnchor({ path: 'notes/guide.md', quote: 'the tools', suffix: ' again' }),
    { kind: 'text', quote: secondQuote, position: secondPosition }
  )
})

Deno.test('add_comment refuses a quote on a drawing', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'sketch.excalidraw', body: 'Look', quote: 'Start' })
  assertStringIncludes(errorText(result), 'sketch.excalidraw is a drawing')
  assertEquals(calls, [])
})

// add_comment: headings.

Deno.test('add_comment finds a heading by its text, its path, or with its #s', async () => {
  const setup = noteAnchor('section', '## Setup')
  assertEquals(await addedAnchor({ path: 'notes/guide.md', heading: 'Guide' }), noteAnchor('section', '# Guide'))
  assertEquals(await addedAnchor({ path: 'notes/guide.md', heading: 'Guide > Setup' }), setup)
  assertEquals(await addedAnchor({ path: 'notes/guide.md', heading: '## Guide > Setup' }), setup)
  const start = NOTE.indexOf('### Setup')
  const [quote, position] = describeRange(NOTE, start, start + '### Setup'.length)
  assertEquals(await addedAnchor({ path: 'notes/guide.md', heading: 'Guide > Use > Setup' }), { kind: 'section', quote, position })
})

Deno.test('an ambiguous heading lists the heading paths', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', heading: 'Setup' })
  assertEquals(
    errorText(result),
    '"Setup" is 2 headings in notes/guide.md. Give its path instead: "Guide > Setup", "Guide > Use > Setup".'
  )
  assertEquals(rpcCalls(calls), [])
  const missing = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', heading: 'Deploy' })
  assertEquals(
    errorText(missing.result),
    'No heading "Deploy" in notes/guide.md. Its headings: "Guide", "Guide > Setup", "Guide > Use", "Guide > Use > Setup".'
  )
})

Deno.test('add_comment refuses a heading on a file that is not a note', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'flow.d2', body: 'Look', heading: 'Setup' })
  assertEquals(errorText(result), 'Only notes (.md and .mdx) have headings. Use quote to comment on text in flow.d2.')
  assertEquals(calls, [])
})

// add_comment: drawing elements.

Deno.test('add_comment anchors a drawing element, labelled by its bound text', async () => {
  assertEquals(
    await addedAnchor({ path: 'sketch.excalidraw', element_id: 'box', point: { x: 0.25, y: 0.5 } }),
    { kind: 'element', element_id: 'box', label: 'Start', point: { x: 0.25, y: 0.5 } }
  )
  assertEquals(
    await addedAnchor({ path: 'sketch.excalidraw', element_id: 'circle' }),
    { kind: 'element', element_id: 'circle', label: 'ellipse' }
  )
})

Deno.test('add_comment refuses an element that is not live in the drawing', async () => {
  for (const element_id of ['gone', 'nothing']) {
    const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'sketch.excalidraw', body: 'Look', element_id })
    assertEquals(errorText(result), `No element ${element_id} in sketch.excalidraw. Read the file for its elements' ids.`)
    assertEquals(rpcCalls(calls), [])
  }
})

Deno.test('add_comment sends diagram element comments to the canvas', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'flow.d2', body: 'Look', element_id: 'd2:a' })
  assertEquals(errorText(result), 'Diagram elements are in its canvas: use path flow.excalidraw.')
  assertEquals(calls, [])
})

// add_comment: the rest.

Deno.test('add_comment with no anchor comments on the whole file', async () => {
  assertEquals(await addedAnchor({ path: 'flow.d2' }), { kind: 'document' })
})

Deno.test('add_comment returns the thread as list_comments shows it', async () => {
  const { result } = await callTool(
    'add_comment',
    { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', quote: 'Intro text' },
    { add_comment: addAnswer }
  )
  const { thread, ...rest } = result.structuredContent as { thread: { thread_id: string } }
  assertMatch(thread.thread_id, UUID)
  assertEquals(rest, { path: 'notes/guide.md', version: 4 })
  assertEquals({ ...thread, thread_id: THREAD }, {
    thread_id: THREAD,
    attached: true,
    resolved: false,
    anchor: { kind: 'text', quote: 'Intro text', line: 3 },
    comments: [{
      comment_id: 'cccccccc-0000-4000-8000-000000000001',
      author: 'Claude for Ada Lovelace',
      via_agent: true,
      body: 'Look',
      created_at: TIME,
      edited_at: null,
      deleted: false,
    }],
  })
})

Deno.test('add_comment refuses mixed anchors before any call', async () => {
  const refused: [Record<string, unknown>, string][] = [
    [{ quote: 'Intro', heading: 'Guide' }, 'Give at most one of quote, heading and element_id.'],
    [{ quote: 'Intro', element_id: 'box' }, 'Give at most one of quote, heading and element_id.'],
    [{ prefix: 'Intro' }, 'prefix and suffix pick one occurrence of quote; give quote too.'],
    [{ suffix: 'Intro' }, 'prefix and suffix pick one occurrence of quote; give quote too.'],
    [{ point: { x: 0.5, y: 0.5 } }, 'point marks a spot on an element; give element_id too.'],
  ]
  for (const [anchor, message] of refused) {
    const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look', ...anchor })
    assertEquals(errorText(result), message)
    assertEquals(calls, [])
  }
  const invalid = [{ body: '' }, { body: 'x'.repeat(100_001) }, { element_id: 'box', point: { x: 2, y: 0 } }]
  for (const args of invalid) {
    const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'sketch.excalidraw', body: 'Look', ...args })
    assert(result.isError, JSON.stringify(args))
    assertEquals(calls, [])
  }
})

Deno.test('add_comment on a missing file says so', async () => {
  const { result, calls } = await callTool('add_comment', { project_id: PROJECT, path: 'nope.md', body: 'Look' })
  assertEquals(errorText(result), 'No file at nope.md in this project. Use list_files to see what exists.')
  assertEquals(rpcCalls(calls), [])
})

// list_comments.

const listAnswer = (threads: unknown[]) => ({ list_comments: () => ({ data: { project_id: PROJECT, revision: 9, threads }, error: null }) })

Deno.test('list_comments without a path counts threads per file', async () => {
  const threads = [
    thread({ kind: 'document' }),
    thread({ kind: 'document' }, { resolved_at: TIME }),
    thread({ kind: 'document' }, { file_id: FILES[2].id, path: 'flow.d2' }),
    thread({ kind: 'document' }, { file_id: 'dddddddd-0000-4000-8000-000000000001', path: 'flow.d2', file_deleted: true, resolved_at: TIME }),
  ]
  const { result, calls } = await callTool('list_comments', { project_id: PROJECT }, listAnswer(threads))
  assertEquals(calls, [{ rpc: 'list_comments', args: { project_id: PROJECT } }])
  assertEquals(result.structuredContent, {
    files: [
      { path: 'flow.d2', file_deleted: false, open: 1, resolved: 0 },
      { path: 'flow.d2', file_deleted: true, open: 0, resolved: 1 },
      { path: 'notes/guide.md', file_deleted: false, open: 1, resolved: 1 },
    ],
  })
})

/** list_comments for one path, with the database listing `threads` for it. */
async function listed(path: string, threads: unknown[], include_resolved?: boolean) {
  const { result, calls } = await callTool('list_comments', { project_id: PROJECT, path, include_resolved }, listAnswer(threads))
  assert(!result.isError, JSON.stringify(result))
  return { content: result.structuredContent as { path: string; version: number | null; threads: Record<string, unknown>[] }, calls }
}

Deno.test('list_comments with a path reads the file and lists its threads', async () => {
  const { content, calls } = await listed('notes/guide.md', [thread({ kind: 'document' })])
  assertEquals(calls, [readQuery('notes/guide.md'), { rpc: 'list_comments', args: { project_id: PROJECT, file_id: FILES[0].id } }])
  assertEquals(content.path, 'notes/guide.md')
  assertEquals(content.version, 4)
  assertEquals(content.threads[0].anchor, { kind: 'document' })
  assertEquals(content.threads[0].attached, true)
})

Deno.test('text threads are found again in the saved file, with their line', async () => {
  // Anchors described against an older version of the note, before its edits.
  const older = NOTE.replace('Intro text.', 'Intro text.\n\n9876543210 9876543210 9876543210.')
  const describe = (text: string) => {
    const start = older.indexOf(text)
    const [quote, position] = describeRange(older, start, start + text.length)
    return { kind: 'text', quote, position }
  }
  const { content } = await listed('notes/guide.md', [
    thread(describe('Install the tools.')),
    thread(describe('Then install the tools again')),
    thread(describe('9876543210 9876543210 9876543210.')),
  ].map((entry, index) => ({ ...entry, id: `bbbbbbbb-0000-4000-8000-00000000000${index}` })))
  assertEquals(content.threads.map((entry) => [entry.attached, entry.anchor]), [
    [true, { kind: 'text', quote: 'Install the tools.', line: 7 }],
    [true, { kind: 'text', quote: 'Then install the tools again', line: 7 }],
    [false, { kind: 'text', original_quote: '9876543210 9876543210 9876543210.' }],
  ])

  const edited = NOTE.replace('Then install', 'Then you install')
  const start = NOTE.indexOf('Then install the tools again')
  const [quote, position] = describeRange(NOTE, start, start + 'Then install the tools again'.length)
  FILES[0].content = edited
  try {
    const { content: again } = await listed('notes/guide.md', [thread({ kind: 'text', quote, position })])
    assertEquals(again.threads[0].anchor, {
      kind: 'text',
      quote: 'Then you install the tools again',
      line: 7,
      original_quote: 'Then install the tools again',
    })
  } finally {
    FILES[0].content = NOTE
  }
})

Deno.test('section threads show their heading path, and detach when the heading becomes prose', async () => {
  const anchor = noteAnchor('section', '## Setup')
  const { content } = await listed('notes/guide.md', [thread(anchor)])
  assertEquals(content.threads[0].anchor, { kind: 'section', heading: 'Guide > Setup', line: 5 })
  assertEquals(content.threads[0].attached, true)

  FILES[0].content = NOTE.replace('## Setup', 'Setup')
  try {
    const { content: prose } = await listed('notes/guide.md', [thread(anchor)])
    assertEquals(prose.threads[0].attached, false)
    assertEquals(prose.threads[0].anchor, { kind: 'section', heading: '## Setup' })
  } finally {
    FILES[0].content = NOTE
  }
})

Deno.test('element threads are attached while their element is live', async () => {
  const onDrawing = { file_id: FILES[1].id, path: 'sketch.excalidraw' }
  const { content } = await listed('sketch.excalidraw', [
    thread({ kind: 'element', element_id: 'box', label: 'Start', point: { x: 0.5, y: 0.5 } }, onDrawing),
    thread({ kind: 'element', element_id: 'gone', label: 'diamond' }, onDrawing),
  ])
  assertEquals(content.threads.map((entry) => [entry.attached, entry.anchor]), [
    [true, { kind: 'element', element_id: 'box', label: 'Start', point: { x: 0.5, y: 0.5 } }],
    [false, { kind: 'element', element_id: 'gone', label: 'diamond' }],
  ])
})

Deno.test('resolved threads are left out unless asked for', async () => {
  const threads = [thread({ kind: 'document' }), thread({ kind: 'document' }, { id: 'bbbbbbbb-0000-4000-8000-000000000009', resolved_at: TIME })]
  assertEquals((await listed('notes/guide.md', threads)).content.threads.map((entry) => entry.resolved), [false])
  assertEquals((await listed('notes/guide.md', threads, true)).content.threads.map((entry) => entry.resolved), [false, true])
})

Deno.test("a deleted file's threads are found by its last path", async () => {
  const gone = { file_id: 'dddddddd-0000-4000-8000-000000000001', path: 'old.md', file_deleted: true }
  const { content, calls } = await listed('old.md', [
    // From a server that gives no names: the author shows by email.
    thread(noteAnchor('text', 'Intro text'), { ...gone, comments: [comment('Is this right?', { author: person('ada@example.com') })] }),
    thread({ kind: 'document' }, { ...gone, path: 'other.md' }),
    thread({ kind: 'document' }),
  ])
  assertEquals(calls, [readQuery('old.md'), { rpc: 'list_comments', args: { project_id: PROJECT } }])
  assertEquals(content.version, null)
  assertEquals(content.threads, [{
    thread_id: THREAD,
    attached: false,
    resolved: false,
    file_deleted: true,
    anchor: { kind: 'text', original_quote: 'Intro text' },
    comments: [{
      comment_id: 'cccccccc-0000-4000-8000-000000000001',
      author: 'ada@example.com',
      via_agent: false,
      body: 'Is this right?',
      created_at: TIME,
      edited_at: null,
      deleted: false,
    }],
  }])

  const { result } = await callTool('list_comments', { project_id: PROJECT, path: 'never.md' }, listAnswer([]))
  assertEquals(errorText(result), 'No file at never.md in this project.')
})

// Replies, resolving, errors.

// list_comments: the threads the user asked an agent about.

Deno.test('list_comments with ask_agent lists the asked threads of every file, with a cursor', async () => {
  const asked = { ask_agent: true }
  const threads = [
    thread(noteAnchor('text', 'Intro text'), asked),
    thread({ kind: 'element', element_id: 'box', label: 'Start' }, { ...asked, id: 'bbbbbbbb-0000-4000-8000-000000000001', file_id: FILES[1].id, path: 'sketch.excalidraw' }),
    thread({ kind: 'document' }, {
      ...asked,
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      comments: [
        comment('Shorter, please.'),
        comment('Done.', { id: 'cccccccc-0000-4000-8000-000000000002', via_agent: true, agent: 'Claude', file_version: 4 }),
      ],
    }),
  ]
  const { result, calls } = await callTool('list_comments', { project_id: PROJECT, ask_agent: true, since: 7 }, listAnswer(threads))
  assert(!result.isError, JSON.stringify(result))
  // One list, then each file read once.
  assertEquals(calls, [
    { rpc: 'list_comments', args: { project_id: PROJECT, ask_agent: true, since: 7 } },
    readQuery('notes/guide.md'),
    readQuery('sketch.excalidraw'),
  ])
  const content = result.structuredContent as { revision: number; threads: Record<string, unknown>[] }
  assertEquals(content.revision, 9)
  assertEquals(content.threads.map((entry) => [entry.path, entry.version, entry.ask_agent, entry.attached]), [
    ['notes/guide.md', 4, true, true],
    ['sketch.excalidraw', 2, true, true],
    ['notes/guide.md', 4, true, true],
  ])
  assertEquals(content.threads[0].anchor, { kind: 'text', quote: 'Intro text', line: 3 })
  assertEquals((content.threads[2].comments as unknown[])[1], {
    comment_id: 'cccccccc-0000-4000-8000-000000000002',
    author: 'Claude for Ada Lovelace',
    via_agent: true,
    body: 'Done.',
    created_at: TIME,
    edited_at: null,
    deleted: false,
    version: 4,
  })
})

Deno.test('list_comments with ask_agent and a path lists only that file; since needs ask_agent', async () => {
  const { calls } = await callTool('list_comments', { project_id: PROJECT, path: 'notes/guide.md', ask_agent: true }, listAnswer([]))
  assertEquals(calls, [readQuery('notes/guide.md'), { rpc: 'list_comments', args: { project_id: PROJECT, file_id: FILES[0].id, ask_agent: true } }])

  const { result, calls: none } = await callTool('list_comments', { project_id: PROJECT, since: 3 })
  assertEquals(errorText(result), 'since works with ask_agent: true.')
  assertEquals(none, [])
})

Deno.test('reply_comment links the version the agent saved', async () => {
  const { result, calls } = await callTool('reply_comment', { thread_id: THREAD, body: 'Done', version: 5 }, {
    reply_comment: (args) => ({
      data: { revision: 6, comment: comment(String(args.body), { id: args.comment_id, via_agent: true, agent: 'Claude', file_version: args.file_version }) },
      error: null,
    }),
  })
  const [call] = rpcCalls(calls)
  const { comment_id, ...rest } = call.args
  assertMatch(String(comment_id), UUID)
  assertEquals(rest, { thread_id: THREAD, body: 'Done', file_version: 5 })
  const sent = (result.structuredContent as { comment: Record<string, unknown> }).comment
  assertEquals([sent.author, sent.version], ['Claude for Ada Lovelace', 5])
})

Deno.test('reply_comment sends a new comment id', async () => {
  const { result, calls } = await callTool('reply_comment', { thread_id: THREAD, body: 'Done' }, {
    reply_comment: (args) => ({ data: { revision: 3, comment: comment(String(args.body), { id: args.comment_id }) }, error: null }),
  })
  const [call] = rpcCalls(calls)
  assertEquals(call.rpc, 'reply_comment')
  const { comment_id, ...rest } = call.args
  assertMatch(String(comment_id), UUID)
  assertEquals(rest, { thread_id: THREAD, body: 'Done' })
  assertEquals((result.structuredContent as { comment: { comment_id: string; body: string } }).comment.body, 'Done')
})

Deno.test('reply_comment takes a comment of 100,000 characters, and refuses a longer one', async () => {
  const reply_comment = (args: Record<string, unknown>) => ({ data: { revision: 3, comment: comment(String(args.body), { id: args.comment_id }) }, error: null })
  const long = await callTool('reply_comment', { thread_id: THREAD, body: 'x'.repeat(100_000) }, { reply_comment })
  assertEquals(rpcCalls(long.calls).length, 1)
  const over = await callTool('reply_comment', { thread_id: THREAD, body: 'x'.repeat(100_001) }, { reply_comment })
  assert(over.result.isError)
  assertEquals(over.calls, [])
})

Deno.test('resolve_comment resolves, or reopens with resolved false', async () => {
  const answers = {
    resolve_comment: () => ({ data: { revision: 3, thread: thread({ kind: 'document' }, { resolved_at: TIME }) }, error: null }),
    reopen_comment: () => ({ data: { revision: 4, thread: thread({ kind: 'document' }) }, error: null }),
  }
  const resolved = await callTool('resolve_comment', { thread_id: THREAD }, answers)
  assertEquals(resolved.calls, [{ rpc: 'resolve_comment', args: { thread_id: THREAD } }])
  assertEquals(resolved.result.structuredContent, { thread_id: THREAD, path: 'notes/guide.md', resolved: true })
  const explicit = await callTool('resolve_comment', { thread_id: THREAD, resolved: true }, answers)
  assertEquals(explicit.calls, [{ rpc: 'resolve_comment', args: { thread_id: THREAD } }])
  const reopened = await callTool('resolve_comment', { thread_id: THREAD, resolved: false }, answers)
  assertEquals(reopened.calls, [{ rpc: 'reopen_comment', args: { thread_id: THREAD } }])
  assertEquals(reopened.result.structuredContent, { thread_id: THREAD, path: 'notes/guide.md', resolved: false })
})

Deno.test('a limit error comes back unchanged', async () => {
  const message = 'You have reached the limit of 120 comment changes a minute. Try again in 42 seconds.'
  const refuse = () => ({ data: null, error: { code: 'PT429', message, details: 'comment_writes_per_minute', hint: null } })
  const { result } = await callTool('reply_comment', { thread_id: THREAD, body: 'Again' }, { reply_comment: refuse })
  assertEquals(errorText(result), message)
  const added = await callTool('add_comment', { project_id: PROJECT, path: 'notes/guide.md', body: 'Look' }, { add_comment: refuse })
  assertEquals(errorText(added.result), message)
  const other = await callTool('resolve_comment', { thread_id: THREAD }, {
    resolve_comment: () => ({ data: null, error: { code: '42501', message: 'Comment unavailable', details: null, hint: null } }),
  })
  assertEquals(errorText(other.result), '[42501] Comment unavailable')
})
