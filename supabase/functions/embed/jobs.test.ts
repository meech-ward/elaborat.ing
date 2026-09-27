import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { embeddingInput, type FileRow, type Job, type PassageRow, type PassageStore, processJobs } from './jobs.ts'

/** An in-memory store that records what the jobs did. */
function fakeStore(files: FileRow[]) {
  const replaced: Array<{ fileId: string; version: string; rows: PassageRow[]; jobId: number }> = []
  const finished: number[] = []
  const store: PassageStore = {
    file: async (fileId) => files.find((file) => file.id === fileId) ?? null,
    replace: async (file, rows, jobId) => {
      replaced.push({ fileId: file.id, version: file.version, rows, jobId })
    },
    finish: async (jobId) => {
      finished.push(jobId)
    },
  }
  return { store, replaced, finished }
}

const note: FileRow = {
  id: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-0000000000aa',
  path: 'notes/sauce.md',
  content: '# Sauce\n\nSlow simmered tomato sauce.\n\n## Serving\n\nWith pasta.\n',
  version: '7',
}
const job = (jobId: number, fileId: string): Job => ({ jobId, fileId })
const inputs: string[] = []
const embed = async (text: string) => {
  inputs.push(text)
  return [text.length, 0, 1]
}

Deno.test('a note becomes one passage per heading, each embedded with its headings', async () => {
  inputs.length = 0
  const { store, replaced, finished } = fakeStore([note])
  const outcome = await processJobs([job(1, note.id)], store, embed)
  assertEquals(outcome, { completed: [job(1, note.id)], failed: [] })
  assertEquals(finished, [])
  assertEquals(replaced.length, 1)
  const [write] = replaced
  assertEquals([write.fileId, write.version, write.jobId], [note.id, '7', 1])
  assertEquals(
    write.rows.map((row) => [row.ordinal, row.headings, row.content]),
    [
      [0, 'Sauce', 'Slow simmered tomato sauce.'],
      [1, 'Sauce > Serving', 'With pasta.'],
    ],
  )
  assertEquals(inputs, ['Sauce\n\nSlow simmered tomato sauce.', 'Sauce > Serving\n\nWith pasta.'])
  for (const row of write.rows) {
    assertEquals(note.content.slice(row.startOffset, row.endOffset).includes(row.content.split(' ')[0]), true)
    assertEquals(row.embedding, [embeddingInput(row.headings.split(' > '), row.content).length, 0, 1])
  }
})

Deno.test('a drawing becomes a passage of its text, embedded as that text', async () => {
  inputs.length = 0
  const elements = [
    { id: 'b', type: 'text', x: 0, y: 80, text: 'Simmer for an hour', originalText: 'Simmer for an hour' },
    { id: 'a', type: 'text', x: 0, y: 0, text: 'Tomato sauce', originalText: 'Tomato sauce' },
    { id: 'c', type: 'ellipse', x: 0, y: 40 },
  ]
  const drawing: FileRow = { ...note, path: 'sketches/sauce.excalidraw', content: JSON.stringify({ type: 'excalidraw', elements }) }
  const { store, replaced } = fakeStore([drawing])
  await processJobs([job(4, drawing.id)], store, embed)
  assertEquals(
    replaced.map((write) => write.rows.map((row) => [row.ordinal, row.headings, row.content, row.startOffset, row.endOffset])),
    [[[0, '', 'Tomato sauce\nSimmer for an hour', 0, drawing.content.length]]],
  )
  assertEquals(inputs, ['Tomato sauce\nSimmer for an hour'])
})

Deno.test('a file that no longer exists just finishes its job', async () => {
  const { store, replaced, finished } = fakeStore([])
  const outcome = await processJobs([job(2, note.id)], store, embed)
  assertEquals(outcome.completed.length, 1)
  assertEquals(replaced, [])
  assertEquals(finished, [2])
})

Deno.test('a file renamed to something that is not a note or diagram loses its passages', async () => {
  const { store, replaced } = fakeStore([{ ...note, path: 'notes/sauce.json' }])
  await processJobs([job(3, note.id)], store, embed)
  assertEquals(replaced.map((write) => write.rows), [[]])
})

Deno.test('one failing job leaves the others to finish, and is reported', async () => {
  const other: FileRow = { ...note, id: '00000000-0000-4000-8000-000000000002', path: 'b.md', content: '# B\n\nText.\n' }
  const { store, replaced } = fakeStore([note, other])
  const failing = async (text: string) => {
    if (text.includes('tomato')) throw new Error('model unavailable')
    return [1]
  }
  const outcome = await processJobs([job(1, note.id), job(2, other.id)], store, failing)
  assertEquals(outcome.completed, [job(2, other.id)])
  assertEquals(outcome.failed, [{ ...job(1, note.id), error: 'model unavailable' }])
  assertEquals(replaced.map((write) => write.fileId), [other.id])
})

Deno.test('a passage before any heading is embedded as its text alone', () => {
  assertEquals(embeddingInput([], 'Intro.'), 'Intro.')
})

Deno.test("a diagram's generated canvas gets no passages: its words are the diagram's", async () => {
  const canvas: FileRow = {
    id: '00000000-0000-4000-8000-000000000009',
    projectId: note.projectId,
    path: 'flows/signup.excalidraw',
    content: JSON.stringify({ type: 'excalidraw', elements: [{ id: 't', type: 'text', x: 0, y: 0, text: 'api', originalText: 'api' }] }),
    version: '2',
    diagramCanvas: true,
  }
  const { store, replaced } = fakeStore([canvas])
  await processJobs([job(9, canvas.id)], store, embed)
  // Replaced with nothing, so passages written before are removed.
  assertEquals(replaced.map((write) => [write.fileId, write.rows.length]), [[canvas.id, 0]])
})
