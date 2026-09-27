import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { handleSearch, type SearchDeps, type SearchResult } from './handler.ts'

const result: SearchResult = {
  passage_id: 1,
  project_id: 'p',
  file_id: 'f',
  path: 'notes/sauce.md',
  headings: 'Sauce',
  content: 'Slow simmered tomato sauce.',
  start_offset: 0,
  end_offset: 30,
  score: 0.03,
}

function deps(answer: Awaited<ReturnType<SearchDeps['hybridSearch']>>) {
  const calls: Array<Parameters<SearchDeps['hybridSearch']>[0]> = []
  const embedded: string[] = []
  const value: SearchDeps = {
    embed: async (text) => {
      embedded.push(text)
      return [0.5, -0.5]
    },
    hybridSearch: async (args) => {
      calls.push(args)
      return answer
    },
  }
  return { value, calls, embedded }
}

Deno.test('a query is embedded once and searched with its embedding and count', async () => {
  const { value, calls, embedded } = deps({ data: [result], error: null })
  const response = await handleSearch({ query: '  tomato sauce ', matchCount: 5 }, value)
  assertEquals(response.status, 200)
  assertEquals(await response.json(), { results: [result] })
  assertEquals(embedded, ['tomato sauce'])
  assertEquals(calls, [{ query_text: 'tomato sauce', query_embedding: '[0.5,-0.5]', match_count: 5 }])
})

Deno.test('a project id narrows the search to that project', async () => {
  const { value, calls } = deps({ data: [result], error: null })
  const projectId = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e'
  assertEquals((await handleSearch({ query: 'tomato', projectId }, value)).status, 200)
  assertEquals(calls, [{ query_text: 'tomato', query_embedding: '[0.5,-0.5]', match_count: 10, filter_project_id: projectId }])
})

Deno.test('a project id that is not a UUID is refused without searching', async () => {
  const { value, calls, embedded } = deps({ data: [], error: null })
  for (const projectId of ['p', 42, '']) assertEquals((await handleSearch({ query: 'tomato', projectId }, value)).status, 400)
  assertEquals([calls.length, embedded.length], [0, 0])
})

Deno.test('the count defaults to 10 and may not pass 30', async () => {
  const { value, calls } = deps({ data: [], error: null })
  await handleSearch({ query: 'basil' }, value)
  assertEquals(calls[0].match_count, 10)
  assertEquals((await handleSearch({ query: 'basil', matchCount: 31 }, value)).status, 400)
})

Deno.test('an empty or missing query is refused without searching', async () => {
  const { value, calls, embedded } = deps({ data: [], error: null })
  for (const body of [{ query: '   ' }, {}, null, 'tomato']) assertEquals((await handleSearch(body, value)).status, 400)
  assertEquals([calls.length, embedded.length], [0, 0])
})

Deno.test('a database error is reported, not hidden as no results', async () => {
  const { value } = deps({ data: null, error: { message: 'permission denied for function hybrid_search' } })
  const response = await handleSearch({ query: 'tomato' }, value)
  assertEquals(response.status, 500)
  assertEquals(await response.json(), { error: 'permission denied for function hybrid_search' })
})
