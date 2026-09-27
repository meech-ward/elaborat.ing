import { z } from 'npm:zod@4.4.3'

// Search a signed-in person's projects, or one of them: embed the query with
// the model that embedded the passages, then run public.hybrid_search as that
// person, so RLS keeps results to projects they can read.

export const SearchRequest = z.object({
  query: z.string().trim().min(1).max(500),
  matchCount: z.number().int().min(1).max(30).default(10),
  /** Only this project's passages. */
  projectId: z.uuid().optional(),
})

export type SearchResult = {
  passage_id: number
  project_id: string
  file_id: string
  path: string
  headings: string
  content: string
  start_offset: number
  end_offset: number
  score: number
}

export type SearchDeps = {
  embed: (text: string) => Promise<number[]>
  /** `public.hybrid_search` as the caller. */
  hybridSearch: (args: { query_text: string; query_embedding: string; match_count: number; filter_project_id?: string }) => Promise<{ data: SearchResult[] | null; error: { message: string } | null }>
}

export async function handleSearch(body: unknown, deps: SearchDeps): Promise<Response> {
  const request = SearchRequest.safeParse(body)
  if (!request.success) return Response.json({ error: request.error.message }, { status: 400 })
  const { query, matchCount, projectId } = request.data
  const embedding = await deps.embed(query)
  const { data, error } = await deps.hybridSearch({
    query_text: query,
    query_embedding: JSON.stringify(embedding),
    match_count: matchCount,
    ...(projectId ? { filter_project_id: projectId } : {}),
  })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ results: data ?? [] })
}
