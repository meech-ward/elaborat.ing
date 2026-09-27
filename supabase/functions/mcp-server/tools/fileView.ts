import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { renderMarkdown } from './markdown.ts'
import { path, projectId } from './projects.ts'
import { errorResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// show_file and its MCP Apps view. Hosts that render MCP Apps (Claude and
// ChatGPT) read `_meta.ui.resourceUri` from the tool, load that ui:// resource
// with resources/read, render it in a sandboxed frame and pass it the tool
// result. Other clients get the text result. The view is on its own tool, not
// on read_file, because agents read files all the time to work on them; a
// view on every read would fill the chat. OpenAI's guidance says the same:
// keep data tools plain and put the view on a render tool.
// https://modelcontextprotocol.io/docs/extensions/apps
// https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt

/** Change the URI when the HTML changes incompatibly: hosts may cache by it. */
export const FILE_VIEW_URI = 'ui://elaborating/file-view-v1.html'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

const APP_ORIGIN = 'https://elaborat.ing'

/** Characters of a note rendered in the view; the rest is a click away. */
const PREVIEW_LIMIT = 40_000

export type FileKind = 'note' | 'drawing' | 'diagram' | 'file'

export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.md')) return 'drawing'
  if (lower.endsWith('.d2')) return 'diagram'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'note'
  return 'file'
}

/** The file's page in the app, with each path segment percent-encoded. */
export function fileUrl(projectId: string, path: string): string {
  return `${APP_ORIGIN}/projects/${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function preview(content: string): { source: string; truncated: boolean } {
  if (content.length <= PREVIEW_LIMIT) return { source: content, truncated: false }
  const cut = content.lastIndexOf('\n', PREVIEW_LIMIT)
  return { source: content.slice(0, cut > 0 ? cut : PREVIEW_LIMIT), truncated: true }
}

export function registerFileView(server: McpServer, { supabase }: ToolContext): void {
  server.registerResource(
    'file_view',
    FILE_VIEW_URI,
    {
      title: 'File view',
      description: 'A read-only view of one file with a link to open it in elaborat.ing. Used by show_file.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    () => ({
      contents: [
        {
          uri: FILE_VIEW_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: FILE_VIEW_HTML,
          // The view draws its own card, so the host adds no frame of its own.
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    })
  )

  server.registerTool(
    'show_file',
    {
      title: 'Show file',
      description:
        'Show one file to the user in the chat as a read-only card with a link to open it in elaborat.ing. ' +
        'Notes are rendered; drawings and diagrams show their name and the link. ' +
        'Use this when the user wants to see a file. To read a file yourself, use read_file.',
      inputSchema: z.object({ project_id: projectId, path }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: FILE_VIEW_URI } },
    },
    async ({ project_id, path }) => {
      try {
        const { data, error } = await supabase
          .from('project_files')
          .select('path, content, version, updated_at')
          .eq('project_id', project_id)
          .eq('path', path)
          .maybeSingle()
        if (error) throw error
        if (!data) return errorResult(`No file at ${path} in this project. Use list_files to see what exists.`)
        const kind = fileKind(data.path)
        const url = fileUrl(project_id, data.path)
        const note = kind === 'note' ? preview(String(data.content ?? '')) : null
        return {
          content: [
            { type: 'text', text: `Showing ${data.path} (version ${data.version}) to the user. Open it in elaborat.ing: ${url}` },
          ],
          structuredContent: {
            project_id,
            path: data.path,
            kind,
            version: data.version,
            updated_at: data.updated_at ?? null,
            url,
            html: note ? renderMarkdown(note.source) : null,
            truncated: note?.truncated ?? false,
          },
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
