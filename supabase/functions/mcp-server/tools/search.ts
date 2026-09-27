import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { projectId } from './projects.ts'
import { jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Hybrid search over the user's notes and diagrams, as the user: the query is
// embedded with the model that embedded the passages, and public.hybrid_search
// runs under RLS, so results come only from projects the user can read.

export function registerSearchTool(server: McpServer, { supabase, embed }: ToolContext): void {
  server.registerTool(
    'search',
    {
      description:
        'Search the notes and diagrams in the projects the user can read, or in one project, by keywords and by meaning. Returns passages, best match first, each with its project_id, path, headings, content and its start and end offsets in the file. Files are indexed shortly after they are saved.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('What to look for, in words.'),
        match_count: z.number().int().min(1).max(30).optional().describe('How many passages to return, up to 30. Defaults to 10.'),
        project_id: projectId.optional().describe('Only search this project, by its id from list_projects. Leave it out to search every project.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, match_count, project_id }) => {
      try {
        const embedding = await embed(query)
        const { data, error } = await supabase.rpc('hybrid_search', {
          query_text: query,
          query_embedding: JSON.stringify(embedding),
          match_count: match_count ?? 10,
          ...(project_id ? { filter_project_id: project_id } : {}),
        })
        if (error) throw error
        return jsonResult({ passages: data })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
