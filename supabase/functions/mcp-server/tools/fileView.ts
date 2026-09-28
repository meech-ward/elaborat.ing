import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { z } from 'npm:zod@4.4.3'

import { COMPONENTS_META_KEY, componentSources } from './componentSources.ts'
import { drawingSvg, MAX_SVG_CHARS, parseDrawing } from './drawingSvg.ts'
import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { type EmbedRef, renderNote } from './markdown.ts'
import { path, projectId, VIEW_CALLABLE } from './projects.ts'
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

/** Change the URI when the HTML changes: hosts cache the view by it. */
export const FILE_VIEW_URI = 'ui://elaborating/file-view-v8.html'
/** Earlier URIs still served, with the current HTML, until hosts refresh the tool list. */
const OLD_FILE_VIEW_URIS = [
  'ui://elaborating/file-view-v1.html',
  'ui://elaborating/file-view-v2.html',
  'ui://elaborating/file-view-v3.html',
  'ui://elaborating/file-view-v4.html',
  'ui://elaborating/file-view-v5.html',
  'ui://elaborating/file-view-v6.html',
  'ui://elaborating/file-view-v7.html',
]
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

const APP_ORIGIN = 'https://elaborat.ing'

/** Characters of a note rendered in the view; the rest is a click away. */
const PREVIEW_LIMIT = 40_000
/** Different drawings and diagrams drawn for one note; later ones show as links. */
export const MAX_EMBEDS = 8
/** SVG characters in one result, over all its drawings (each is at most MAX_SVG_CHARS). */
export const MAX_TOTAL_SVG_CHARS = 600_000
/** A drawing file longer than this is not read to draw it. */
const MAX_SCENE_CHARS = 5_000_000
/** The result `_meta` key holding each drawn file's SVG by path. `_meta` reaches the view, not the model. */
export const SVG_META_KEY = 'elaborat.ing/svg'
/** The result `_meta` key holding a note's rendered HTML, which the model doesn't need to read. */
export const HTML_META_KEY = 'elaborat.ing/html'
/** The result `_meta` key holding a note's source, which the view edits. */
export const SOURCE_META_KEY = 'elaborat.ing/source'

export type FileKind = 'note' | 'drawing' | 'diagram' | 'file' | 'component'

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

/** The project's page in the app. */
export function projectUrl(projectId: string): string {
  return `${APP_ORIGIN}/projects/${projectId}`
}

/** A diagram's generated canvas, drawn by the app next to its `.d2` source. */
export function companionPath(path: string): string {
  return path.replace(/\.d2$/i, '.excalidraw')
}

/** The diagram's layout record, which holds the hash of the source its canvas was drawn from. */
export function sidecarPath(path: string): string {
  return `${path}.json`
}

/** The app's fingerprint of a diagram's source (src/features/structured/sourceHash.ts). */
export function sourceHash(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return ('0000000' + (hash >>> 0).toString(16)).slice(-8)
}

/** True when the diagram's layout record says its canvas was drawn from other source. */
function drawnFromOtherSource(path: string, files: Map<string, string>): boolean {
  const record = files.get(sidecarPath(path))
  if (record === undefined) return false
  try {
    const hash = JSON.parse(record)?.sourceHash
    return typeof hash === 'string' && hash !== sourceHash(files.get(path) ?? '')
  } catch {
    return false
  }
}

export type EmbedStatus = 'drawn' | 'stale' | 'not_drawn' | 'missing' | 'unreadable' | 'empty' | 'too_big' | 'not_shown' | 'unsupported'
export type EmbedView = EmbedRef & { url: string; status: EmbedStatus }

function drawOne(path: string, files: Map<string, string>, budget: number): { status: EmbedStatus; svg?: string } {
  const kind = fileKind(path)
  if (kind !== 'drawing' && kind !== 'diagram') return { status: 'unsupported' }
  if (!files.has(path)) return { status: 'missing' }
  const content = files.get(kind === 'diagram' ? companionPath(path) : path)
  if (content === undefined) return { status: 'not_drawn' }
  if (content.length > MAX_SCENE_CHARS) return { status: 'too_big' }
  let elements
  try {
    elements = parseDrawing(content)
  } catch {
    return { status: 'unreadable' }
  }
  const drawn = drawingSvg(elements, Math.min(MAX_SVG_CHARS, budget), { diagram: kind === 'diagram' })
  if (!('svg' in drawn)) return { status: drawn.problem }
  return { status: kind === 'diagram' && drawnFromOtherSource(path, files) ? 'stale' : 'drawn', svg: drawn.svg }
}

/**
 * Draws the first MAX_EMBEDS different files the refs name, reading them
 * (and each diagram's companion) as the user in one query. `known` holds
 * contents already read.
 */
async function drawEmbeds(
  supabase: SupabaseClient,
  projectId: string,
  refs: EmbedRef[],
  known: Record<string, string> = {}
): Promise<{ embeds: EmbedView[]; svgs: Record<string, string> }> {
  const drawn = [...new Set(refs.map((ref) => ref.path))].slice(0, MAX_EMBEDS)
  const files = new Map(Object.entries(known))
  const wanted = new Set(drawn.flatMap((path) => (fileKind(path) === 'diagram' ? [path, companionPath(path), sidecarPath(path)] : [path])))
  for (const path of files.keys()) wanted.delete(path)
  if (wanted.size > 0) {
    const { data, error } = await supabase
      .from('project_files')
      .select('path, content')
      .eq('project_id', projectId)
      .in('path', [...wanted])
    if (error) throw error
    for (const row of data ?? []) files.set(row.path, String(row.content ?? ''))
  }
  const svgs: Record<string, string> = {}
  const statuses = new Map<string, EmbedStatus>()
  let budget = MAX_TOTAL_SVG_CHARS
  for (const path of drawn) {
    const { status, svg } = drawOne(path, files, budget)
    statuses.set(path, status)
    if (svg) {
      svgs[path] = svg
      budget -= svg.length
    }
  }
  const embeds = refs.map((ref) => ({ ...ref, url: fileUrl(projectId, ref.path), status: statuses.get(ref.path) ?? 'not_shown' }))
  return { embeds, svgs }
}

function preview(content: string): { source: string; truncated: boolean } {
  if (content.length <= PREVIEW_LIMIT) return { source: content, truncated: false }
  const cut = content.lastIndexOf('\n', PREVIEW_LIMIT)
  return { source: content.slice(0, cut > 0 ? cut : PREVIEW_LIMIT), truncated: true }
}

export function registerFileView(server: McpServer, { supabase }: ToolContext): void {
  for (const [index, uri] of [FILE_VIEW_URI, ...OLD_FILE_VIEW_URIS].entries()) {
    server.registerResource(
      index === 0 ? 'file_view' : `file_view_${index}`,
      uri,
      {
        title: 'File view',
        description:
          'A view of one file with a link to open it in elaborat.ing; notes can be edited in it, and components are previewed. ' +
          'Used by show_file and preview_component.',
        mimeType: MCP_APP_MIME_TYPE,
      },
      () => ({
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: FILE_VIEW_HTML,
            // The view draws its own card, so the host adds no frame of its own.
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      })
    )
  }

  server.registerTool(
    'show_file',
    {
      title: 'Show file',
      description:
        'Show one file to the user in the chat as a card with a link to open it in elaborat.ing. ' +
        'Notes are rendered, and drawings and diagrams are drawn, also where a note embeds them. ' +
        "An MDX note's components, built in or imported from the project's files, are previewed where the chat allows it. " +
        'Where the chat allows it, the user can edit a note in the card and save it; read the file again after that. ' +
        'Use this when the user wants to see or edit a file. To read a file yourself, use read_file.',
      inputSchema: z.object({ project_id: projectId, path }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...VIEW_CALLABLE, ui: { ...VIEW_CALLABLE.ui, resourceUri: FILE_VIEW_URI } },
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
        const content = String(data.content ?? '')
        const note = kind === 'note' ? preview(content) : null
        const rendered = note ? renderNote(note.source) : null
        const refs: EmbedRef[] = rendered?.embeds ?? (kind === 'drawing' || kind === 'diagram' ? [{ kind, path: data.path }] : [])
        const { embeds, svgs } = refs.length > 0 ? await drawEmbeds(supabase, project_id, refs, { [data.path]: content }) : { embeds: [], svgs: {} }
        // An MDX note shown whole whose components the HTML shows as text: the view previews them from these.
        const previewed = rendered?.mdx && note && !note.truncated && data.path.toLowerCase().endsWith('.mdx')
        const modules = previewed ? await componentSources(supabase, project_id, content) : null
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
            truncated: note?.truncated ?? false,
            embeds,
          },
          ...(rendered || Object.keys(svgs).length > 0
            ? {
                _meta: {
                  ...(rendered ? { [HTML_META_KEY]: rendered.html } : {}),
                  ...(Object.keys(svgs).length > 0 ? { [SVG_META_KEY]: svgs } : {}),
                  // The whole note, for editing in the view; a note too long to show whole is not edited there.
                  ...(note && !note.truncated ? { [SOURCE_META_KEY]: content } : {}),
                  ...(modules ? { [COMPONENTS_META_KEY]: { modules } } : {}),
                },
              }
            : {}),
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
