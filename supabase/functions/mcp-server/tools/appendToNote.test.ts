import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { type CallToolResult, InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

import { registerTools, type ToolContext } from './index.ts'

// append_to_note on a real McpServer through a real MCP client, with a
// stand-in for the project's files: read by path, saved by save_files with
// the database's version check (a put whose base_version is not the file's
// version, or that has none where a file exists, is a conflict) and its
// receipts (a repeated mutation id gets its save's result, and a different
// save under one id is refused), and each save's versions by mutation id.

const PROJECT = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
const PATH = 'notes/launch.mdx'
const NOTE = '# Launch plan\n\nWhat ships on day one.\n'

type Stored = { content: string; version: number }
type Save = { project_id: string; mutation_id: string; changes: { op: string; path: string; content: string; base_version?: number }[] }

/**
 * The project's files by path. `interrupt` runs as each save arrives, before
 * its version check, so a test can save for someone else in between.
 */
function project(files: Record<string, Stored>, interrupt?: (project: { save: (path: string, content: string) => void }) => void) {
  const saves: Save[] = []
  const versions: { path: string; version: number; content: string; mutation_id: string }[] = []
  const receipts = new Map<string, { changes: string; result: unknown }>()
  let revision = Math.max(0, ...Object.values(files).map((file) => file.version))
  const save = (path: string, content: string, mutation: string = crypto.randomUUID()) => {
    revision++
    files[path] = { content, version: revision }
    versions.push({ path, version: revision, content, mutation_id: mutation })
  }
  const supabase = {
    from(table: string) {
      const eq: Record<string, unknown> = {}
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => ((eq[key] = value), builder),
        // A file by its path.
        maybeSingle: () => {
          assertEquals([table, eq.project_id], ['project_files', PROJECT])
          const file = files[eq.path as string]
          return Promise.resolve({ data: file ? { ...file } : null, error: null })
        },
        // The versions a save made, by its mutation id.
        then: (resolve: (value: unknown) => void) => {
          assertEquals([table, eq.project_id], ['file_versions', PROJECT])
          const made = versions.filter((row) => row.mutation_id === eq.mutation_id)
          resolve({ data: made.map(({ path, version, content }) => ({ path, version, content })), error: null })
        },
      }
      return builder
    },
    rpc(name: string, args: Save) {
      assertEquals(name, 'save_files')
      saves.push(JSON.parse(JSON.stringify(args)))
      const receipt = receipts.get(args.mutation_id)
      if (receipt) {
        return Promise.resolve(
          receipt.changes === JSON.stringify(args.changes)
            ? { data: receipt.result, error: null }
            : { data: null, error: { code: '22023', message: 'This mutation id was already used for a different save' } }
        )
      }
      interrupt?.({ save })
      const [change] = args.changes
      const file = files[change.path]
      if (file?.version !== change.base_version) {
        const current = file ? { version: file.version, content: file.content } : null
        return Promise.resolve({ data: { status: 'conflict', conflicts: [{ path: change.path, base_version: change.base_version ?? null, current }] }, error: null })
      }
      save(change.path, change.content, args.mutation_id)
      const result = { status: 'saved', changes: [{ op: 'put', path: change.path, version: revision }] }
      receipts.set(args.mutation_id, { changes: JSON.stringify(args.changes), result })
      return Promise.resolve({ data: result, error: null })
    },
  } as unknown as SupabaseClient
  return { supabase, files, saves }
}

async function withClient<T>(supabase: SupabaseClient, run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase } as unknown as ToolContext)
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

const append = (supabase: SupabaseClient, args: Record<string, unknown>) =>
  withClient(supabase, async (client) =>
    (await client.callTool({ name: 'append_to_note', arguments: { project_id: PROJECT, path: PATH, ...args } })) as CallToolResult
  )

const text = (result: CallToolResult) => (result.content[0] as { text: string }).text

Deno.test('append_to_note creates the note, then adds each section after it', async () => {
  const { supabase, files, saves } = project({})
  const first = await append(supabase, { text: '# Launch plan\n\nWhat ships on day one.' })
  assert(!first.isError, text(first))
  assertEquals(first.structuredContent, { path: PATH, version: 1, added: 37, length: 38 })
  assertEquals(files[PATH], { content: '# Launch plan\n\nWhat ships on day one.\n', version: 1 })
  // One save, as write_file makes it: a put with no version, which only creates.
  assertEquals(saves.map((save) => save.changes.map(({ op, path, base_version }) => ({ op, path, base_version }))), [[{ op: 'put', path: PATH, base_version: undefined }]])
  assertMatch(saves[0].mutation_id, /^[0-9a-f-]{36}$/)

  const second = await append(supabase, { text: '## Risks\n\n- The import is slow.', base_version: 1 })
  assert(!second.isError, text(second))
  assertEquals(second.structuredContent, { path: PATH, version: 2, added: 31, length: 71 })
  assertEquals(files[PATH].content, '# Launch plan\n\nWhat ships on day one.\n\n## Risks\n\n- The import is slow.\n')
  // Saved with the version it read, as write_file saves a change.
  assertEquals(saves[1].changes[0].base_version, 1)
})

Deno.test('the text goes after the note with exactly one blank line between, whatever whitespace either has there', async () => {
  // The note, the text, the note after, and the characters added.
  const cases: [string, string, string, number][] = [
    ['# Plan\n\nFirst.\n', '## Next\n\nSecond.', '# Plan\n\nFirst.\n\n## Next\n\nSecond.\n', 16],
    // A note without a line break at its end, and text without one.
    ['# Plan\n\nFirst.', '## Next', '# Plan\n\nFirst.\n\n## Next\n', 7],
    // Blank lines and spaces at the end of the note and around the text go.
    ['# Plan\n\nFirst.  \n\n\n \t\n', '\n\n  \n## Next\n\nSecond.\n\n\n', '# Plan\n\nFirst.\n\n## Next\n\nSecond.\n', 16],
    // The first line of the text keeps its indent: here, a code block.
    ['Intro.\n', '\n    const x = 1\n', 'Intro.\n\n    const x = 1\n', 15],
    // A note of nothing but whitespace is the text alone.
    ['', 'Only.', 'Only.\n', 5],
    ['\n \n', 'Only.', 'Only.\n', 5],
  ]
  for (const [before, added, after, count] of cases) {
    const { supabase, files } = project({ [PATH]: { content: before, version: 3 } })
    const result = await append(supabase, { text: added })
    assert(!result.isError, text(result))
    assertEquals(files[PATH].content, after, JSON.stringify(before))
    assertEquals(result.structuredContent, { path: PATH, version: 4, added: count, length: after.length })
  }
})

Deno.test('append_to_note adds at most 4,000 characters a call, and something other than whitespace', async () => {
  const listed = await withClient(project({}).supabase, async (client) => (await client.listTools()).tools.find((tool) => tool.name === 'append_to_note'))
  assertEquals((listed?.inputSchema.properties?.text as { maxLength?: number }).maxLength, 4000)

  const { supabase, files, saves } = project({ [PATH]: { content: NOTE, version: 3 } })
  const most = 'x'.repeat(4000)
  const result = await append(supabase, { text: most })
  assert(!result.isError, text(result))
  assertEquals(files[PATH], { content: `${NOTE}\n${most}\n`, version: 4 })
  for (const [args, message] of [
    [{ text: 'x'.repeat(4001) }, '4000'],
    [{ text: '' }, 'text'],
    [{ text: '\n  \n\t' }, 'The text is only whitespace. Nothing was saved.'],
  ] as const) {
    const refused = await append(supabase, args)
    assert(refused.isError, message)
    assertStringIncludes(text(refused), message)
  }
  assertEquals(saves.length, 1)
  assertEquals(files[PATH].version, 4)
})

Deno.test('with a base_version the note no longer has, append_to_note saves nothing and says what it is now', async () => {
  const refusals: [Record<string, Stored>, number, string][] = [
    [{ [PATH]: { content: NOTE, version: 7 } }, 6, `${PATH} changed since version 6: it is now version 7. Nothing was saved. Read it again, or call append_to_note without base_version to add to it as it is.`],
    [{}, 6, `No note at ${PATH}. Nothing was saved. Call append_to_note without base_version to create it.`],
  ]
  for (const [stored, version, message] of refusals) {
    const { supabase, files, saves } = project(stored)
    const before = JSON.stringify(files)
    const result = await append(supabase, { text: '## Next', base_version: version })
    assert(result.isError)
    assertEquals(text(result), message)
    assertEquals(saves, [])
    assertEquals(JSON.stringify(files), before)
  }

  // The note changes between its read and its save: with base_version, that is the caller's to look at.
  const raced = project({ [PATH]: { content: NOTE, version: 7 } }, ({ save }) => save(PATH, `${NOTE}\nTheirs.\n`))
  const result = await append(raced.supabase, { text: '## Next', base_version: 7 })
  assertEquals(text(result), `${PATH} changed while the text was being added: it is now version 8. Nothing was saved. Read it again, or call append_to_note without base_version.`)
  assertEquals(raced.saves.length, 1)
  assertEquals(raced.files[PATH].content, `${NOTE}\nTheirs.\n`)
})

Deno.test('append_to_note adds once more to a note someone saved in between, and returns the conflict when it happens again', async () => {
  const theirs = (content: string) => `${content.trimEnd()}\n\nTheirs.\n`

  // Once: the person saves first; the text goes after their change.
  let interruptions = 1
  const once = project({ [PATH]: { content: NOTE, version: 7 } }, ({ save }) => {
    if (interruptions-- > 0) save(PATH, theirs(once.files[PATH].content))
  })
  const result = await append(once.supabase, { text: '## Next' })
  assert(!result.isError, text(result))
  assertEquals(result.structuredContent, { path: PATH, version: 9, added: 7, length: 56 })
  assertEquals(once.saves.map((save) => save.changes[0].base_version), [7, 8])
  assertEquals(once.files[PATH].content, '# Launch plan\n\nWhat ships on day one.\n\nTheirs.\n\n## Next\n')

  // Twice: nothing is saved, and it says the note changed.
  const twice = project({ [PATH]: { content: NOTE, version: 7 } }, ({ save }) => save(PATH, theirs(twice.files[PATH].content)))
  const conflict = await append(twice.supabase, { text: '## Next' })
  assert(conflict.isError)
  assertEquals(text(conflict), `${PATH} changed while the text was being added: it is now version 9. Nothing was saved. Call append_to_note again.`)
  assertEquals(twice.saves.length, 2)
  assert(!twice.files[PATH].content.includes('## Next'))
})

Deno.test('a call repeated with its mutation_id gets the save it made, so the text is added once', async () => {
  const { supabase, files, saves } = project({ [PATH]: { content: NOTE, version: 7 } })
  const id = crypto.randomUUID()
  const first = await append(supabase, { text: '## Next', mutation_id: id })
  assertEquals(first.structuredContent, { path: PATH, version: 8, added: 7, length: 47 })
  const again = await append(supabase, { text: '## Next', mutation_id: id })
  assertEquals(again.structuredContent, first.structuredContent)
  assertEquals(saves.map((save) => save.mutation_id), [id])
  assertEquals(files[PATH], { content: `${NOTE}\n## Next\n`, version: 8 })

  // Other text under the same id is refused, as the database refuses a different save under one id.
  const other = await append(supabase, { text: '## Other', mutation_id: id })
  assert(other.isError)
  assertStringIncludes(text(other), 'was already used for a different change. Nothing was saved.')
  assertEquals(saves.length, 1)
})

Deno.test('append_to_note adds to notes only, and says which tool changes another file', async () => {
  const refusals: [string, string][] = [
    ['drawings/flow.excalidraw', 'append_to_note adds to notes (.md or .mdx). To add to a drawing, use draw.'],
    ['drawings/flow.excalidraw.md', 'An Obsidian drawing (.excalidraw.md) is changed with write_file'],
    ['diagrams/flow.d2', 'To change a diagram, read it and use write_file with base_version.'],
    ['components/status.tsx', 'To change another file, read it and use write_file with base_version.'],
  ]
  for (const [path, message] of refusals) {
    const { supabase, files, saves } = project({ [path]: { content: 'kept', version: 2 } })
    const result = await append(supabase, { path, text: '## Next' })
    assert(result.isError, path)
    assertStringIncludes(text(result), message)
    assertEquals(saves, [], path)
    assertEquals(files[path], { content: 'kept', version: 2 })
  }
  // A .md note is a note too, in any case.
  const { supabase, files } = project({ 'README.MD': { content: '# Readme\n', version: 2 } })
  const result = await append(supabase, { path: 'README.MD', text: 'More.' })
  assert(!result.isError, text(result))
  assertEquals(files['README.MD'].content, '# Readme\n\nMore.\n')
})
