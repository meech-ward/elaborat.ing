import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { z } from 'npm:zod@4.4.3'

import { COMPONENTS_META_KEY, componentEditors, componentSources, sharedWithUser } from './componentSources.ts'
import { completeFile, DrawError } from './drawingCompletion.ts'
import { drawingSvg, MAX_SVG_CHARS, parseDrawing } from './drawingSvg.ts'
import { FILE_VIEW_HTML } from './fileViewHtml.ts'
import { type EmbedRef, renderNote } from './markdown.ts'
import { baseVersion, mutationId, path, projectId, VIEW_CALLABLE } from './projects.ts'
import { errorResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// show_file and its MCP Apps view. Hosts that render MCP Apps (Claude and
// ChatGPT) read `_meta.ui.resourceUri` from the tool, load that ui:// resource
// with resources/read, render it in a sandboxed frame and pass it the tool
// result. Other clients get the text result. The view is on its own tool, not
// on read_file, because agents read files all the time to work on them; a
// view on every read would fill the chat. OpenAI's guidance says the same:
// keep data tools plain and put the view on a render tool.
//
// create_and_show is the one other tool with the view: it creates a new note,
// drawing or diagram and shows it, and the view draws it while the agent is
// still writing it (the host's partial tool input). It only creates, so it
// is not destructive, and the database refuses a put without a version on a
// path that exists. update_and_show changes one the same way, saving as
// write_file does: the view first reads the file as saved (read_file), shows
// what stays at once and draws in what changes. Quiet changes stay with
// write_file, which has no view. card_report is the view's own: it logs how
// a live card went, to learn which hosts send the input as it is written.
// card_embed is the view's own too: it sends one drawing or diagram that did
// not fit in show_file's result.
// https://modelcontextprotocol.io/docs/extensions/apps
// https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt

/** Change the URI when the HTML changes: hosts cache the view by it. */
export const FILE_VIEW_URI = 'ui://elaborating/file-view-v51.html'
/** Earlier URIs still served, with the current HTML, until hosts refresh the tool list. */
const OLD_FILE_VIEW_URIS = [
  'ui://elaborating/file-view-v1.html',
  'ui://elaborating/file-view-v2.html',
  'ui://elaborating/file-view-v3.html',
  'ui://elaborating/file-view-v4.html',
  'ui://elaborating/file-view-v5.html',
  'ui://elaborating/file-view-v6.html',
  'ui://elaborating/file-view-v7.html',
  'ui://elaborating/file-view-v8.html',
  'ui://elaborating/file-view-v9.html',
  'ui://elaborating/file-view-v10.html',
  'ui://elaborating/file-view-v11.html',
  'ui://elaborating/file-view-v12.html',
  'ui://elaborating/file-view-v13.html',
  'ui://elaborating/file-view-v14.html',
  'ui://elaborating/file-view-v15.html',
  'ui://elaborating/file-view-v16.html',
  'ui://elaborating/file-view-v17.html',
  'ui://elaborating/file-view-v18.html',
  'ui://elaborating/file-view-v19.html',
  'ui://elaborating/file-view-v20.html',
  'ui://elaborating/file-view-v21.html',
  'ui://elaborating/file-view-v22.html',
  'ui://elaborating/file-view-v23.html',
  'ui://elaborating/file-view-v24.html',
  'ui://elaborating/file-view-v25.html',
  'ui://elaborating/file-view-v26.html',
  'ui://elaborating/file-view-v27.html',
  'ui://elaborating/file-view-v28.html',
  'ui://elaborating/file-view-v29.html',
  'ui://elaborating/file-view-v30.html',
  'ui://elaborating/file-view-v31.html',
  'ui://elaborating/file-view-v32.html',
  'ui://elaborating/file-view-v33.html',
  'ui://elaborating/file-view-v34.html',
  'ui://elaborating/file-view-v35.html',
  'ui://elaborating/file-view-v36.html',
  'ui://elaborating/file-view-v37.html',
  'ui://elaborating/file-view-v38.html',
  'ui://elaborating/file-view-v39.html',
  'ui://elaborating/file-view-v40.html',
  'ui://elaborating/file-view-v41.html',
  'ui://elaborating/file-view-v42.html',
  'ui://elaborating/file-view-v43.html',
  'ui://elaborating/file-view-v44.html',
  'ui://elaborating/file-view-v45.html',
  'ui://elaborating/file-view-v46.html',
  'ui://elaborating/file-view-v47.html',
  'ui://elaborating/file-view-v48.html',
  'ui://elaborating/file-view-v49.html',
  'ui://elaborating/file-view-v50.html',
]
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

const APP_ORIGIN = 'https://elaborat.ing'

/**
 * The view's policy: the spec's default, plus scripts, styles and fonts from
 * the app's site, where the view loads its editor, component previews and
 * diagram engine when they are first needed (public/chat-card, served with
 * CORS). ChatGPT also reads its older `openai/widgetCSP`. A host that does
 * not allow the origin still shows the card, read-only.
 *
 * `openai/widgetDomain` gives the view a dedicated origin of its own in
 * ChatGPT, which a listed plugin needs. It is ChatGPT's name for the spec's
 * `ui.domain`, used instead of it because each host has its own format for
 * that field and Claude refuses to show a view whose `ui.domain` is not the
 * one it derives from the server's URL.
 */
export const FILE_VIEW_META = {
  ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [APP_ORIGIN] } },
  'openai/widgetCSP': { connect_domains: [], resource_domains: [APP_ORIGIN] },
  'openai/widgetDomain': APP_ORIGIN,
}

/** The files create_and_show makes and update_and_show changes: notes, drawings and diagrams. */
const SHOWN_AS_MADE = /\.(md|mdx|excalidraw|d2)$/i

/** The longest a card_report's times may be: a day, in ms. */
const DAY_MS = 86_400_000

/**
 * Characters of a note rendered in the view; the rest is a click away. A
 * note this long takes about 45,000 characters of `_meta` for its HTML and
 * source, and one that is all a table of short cells about 92,000, which
 * leaves the drawings room under MAX_META_CHARS. At 40,000, a data table's
 * HTML and source alone passed it.
 */
const PREVIEW_LIMIT = 20_000
/** Different drawings and diagrams drawn for one note; later ones show as links. */
export const MAX_EMBEDS = 8
/**
 * Characters of `_meta` in one result, as JSON: the note's HTML, its source
 * and its component files, then the SVG of each file drawn here (each at most
 * MAX_SVG_CHARS), then, in what is left, what the view draws a diagram from
 * (D2_META_KEY). A drawing or diagram that does not fit in what is left is
 * deferred: the view loads it with card_embed. Claude keeps a result of more
 * than about 150,000 characters as a file where its code execution is on,
 * and the view then gets no result to show, so this stays under that, with
 * room for the rest of the result.
 * https://claude.com/docs/connectors/building/mcp-apps/troubleshooting
 */
export const MAX_META_CHARS = 120_000
/** A drawing file longer than this is not read to draw it. */
const MAX_SCENE_CHARS = 5_000_000
/** The result `_meta` key holding each drawn file's SVG by path. `_meta` reaches the view, not the model. */
export const SVG_META_KEY = 'elaborat.ing/svg'
/** The result `_meta` key holding a note's rendered HTML, which the model doesn't need to read. */
export const HTML_META_KEY = 'elaborat.ing/html'
/** The result `_meta` key holding a note's source, which the view edits. */
export const SOURCE_META_KEY = 'elaborat.ing/source'
/**
 * The result `_meta` key holding, by path, what the view draws a diagram
 * from when its canvas is missing (not_drawn) or out of date (stale): its D2
 * source, and the canvas and layout record the app saved, if it did. The
 * view lays the diagram out with the app's own D2 engine and keeps what the
 * canvas changed by hand, as the app does when it opens it.
 */
export const D2_META_KEY = 'elaborat.ing/d2'

/** What the view draws a diagram from (D2_META_KEY). */
export type DiagramSource = { source: string; canvas?: string; layout?: string }

/** A value's characters in `_meta` as JSON, with its key, a colon and a comma. */
const metaSize = (key: string, value: unknown) => JSON.stringify(key).length + JSON.stringify(value).length + 2
/** The characters of MAX_META_CHARS left for drawings beside the rest of `_meta`, once their two keys are in. */
const roomBeside = (meta: Record<string, unknown>) => MAX_META_CHARS - JSON.stringify(meta).length - JSON.stringify({ [SVG_META_KEY]: {}, [D2_META_KEY]: {} }).length
/** The room a drawing or diagram has in a result of its own, as when the view loads one that was deferred. */
const ALONE = roomBeside({})

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

/** How a drawing or diagram came out; `deferred`: it did not fit in this result, and the view loads it with card_embed. */
export type EmbedStatus = 'drawn' | 'stale' | 'not_drawn' | 'missing' | 'unreadable' | 'empty' | 'too_big' | 'deferred' | 'not_shown' | 'unsupported'
export type EmbedView = EmbedRef & { url: string; status: EmbedStatus }

function drawOne(path: string, files: Map<string, string>): { status: EmbedStatus; svg?: string } {
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
  const drawn = drawingSvg(elements, MAX_SVG_CHARS, { diagram: kind === 'diagram' })
  if (!('svg' in drawn)) return { status: drawn.problem }
  return { status: kind === 'diagram' && drawnFromOtherSource(path, files) ? 'stale' : 'drawn', svg: drawn.svg }
}

/** What the view draws a diagram from: its source, with its canvas and layout record where they exist. */
function diagramSource(path: string, files: Map<string, string>): DiagramSource {
  const canvas = files.get(companionPath(path))
  const layout = files.get(sidecarPath(path))
  return { source: files.get(path) ?? '', ...(canvas !== undefined ? { canvas } : {}), ...(layout !== undefined ? { layout } : {}) }
}

/**
 * Draws the first MAX_EMBEDS different files the refs name, reading them
 * (and each diagram's companion) as the user in one query. `known` holds
 * contents already read. Their SVG goes in `room`, the characters of `_meta`
 * left for drawings, in the order the refs name them. A diagram whose canvas
 * is missing or out of date goes to the view to draw from its source
 * (`diagrams`), in what is left once the SVG is in. A drawing, or a diagram
 * with no canvas, that does not fit in what is left but would on its own is
 * deferred, for the view to load; one too big for that is not shown.
 */
async function drawEmbeds(
  supabase: SupabaseClient,
  projectId: string,
  refs: EmbedRef[],
  room: number,
  known: Record<string, string> = {}
): Promise<{ embeds: EmbedView[]; svgs: Record<string, string>; diagrams: Record<string, DiagramSource> }> {
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
  let left = room
  for (const path of drawn) {
    const { status, svg } = drawOne(path, files)
    const size = svg === undefined ? 0 : metaSize(path, svg)
    if (svg === undefined) statuses.set(path, status)
    else if (size > ALONE) statuses.set(path, 'too_big')
    else if (size > left) statuses.set(path, 'deferred')
    else {
      statuses.set(path, status)
      svgs[path] = svg
      left -= size
    }
  }
  const diagrams: Record<string, DiagramSource> = {}
  for (const path of drawn) {
    const status = statuses.get(path)
    if (status !== 'not_drawn' && status !== 'stale') continue
    const sent = diagramSource(path, files)
    const size = metaSize(path, sent)
    if (size <= left) {
      diagrams[path] = sent
      left -= size
    } else if (status === 'not_drawn' && size <= ALONE) {
      // It has no drawing to show meanwhile; one out of date shows the one it has.
      statuses.set(path, 'deferred')
    }
  }
  const embeds = refs.map((ref) => ({ ...ref, url: fileUrl(projectId, ref.path), status: statuses.get(ref.path) ?? 'not_shown' }))
  return { embeds, svgs, diagrams }
}

/** show_file's and card_embed's answer for a path with no file the user can read. */
const noFile = (path: string) => errorResult(`No file at ${path} in this project. Use list_files to see what exists.`)

function preview(content: string): { source: string; truncated: boolean } {
  if (content.length <= PREVIEW_LIMIT) return { source: content, truncated: false }
  const cut = content.lastIndexOf('\n', PREVIEW_LIMIT)
  return { source: content.slice(0, cut > 0 ? cut : PREVIEW_LIMIT), truncated: true }
}

/**
 * show_file's result for one file: the card's view of it, with the note's
 * HTML and source, the drawings drawn, and a component preview's sources.
 * `made`: create_and_show just created it, or update_and_show saved it,
 * which the model's text says.
 */
export async function showFilePayload(
  { supabase, userClaims }: ToolContext,
  project_id: string,
  path: string,
  { made }: { made?: 'created' | 'updated' } = {}
): Promise<CallToolResult> {
  try {
    const { data, error } = await supabase
      .from('project_files')
      .select('path, content, version, updated_at')
      .eq('project_id', project_id)
      .eq('path', path)
      .maybeSingle()
    if (error) throw error
    if (!data) return noFile(path)
    const kind = fileKind(data.path)
    const url = fileUrl(project_id, data.path)
    const content = String(data.content ?? '')
    const note = kind === 'note' ? preview(content) : null
    const rendered = note ? renderNote(note.source) : null
    const refs: EmbedRef[] = rendered?.embeds ?? (kind === 'drawing' || kind === 'diagram' ? [{ kind, path: data.path }] : [])
    // An MDX note shown whole whose components the HTML shows as text: the view previews them from these.
    const previewed = rendered?.mdx && note && !note.truncated && data.path.toLowerCase().endsWith('.mdx')
    const modules = previewed ? await componentSources(supabase, project_id, content) : null
    // Only a previewed note's custom components ask first, naming who last changed the files they come from.
    const shared = modules ? await sharedWithUser(supabase, project_id, userClaims?.id) : false
    const editors = shared && modules ? await componentEditors(supabase, project_id, [data.path, ...Object.keys(modules)], userClaims?.id) : null
    // The view's part of the result, which the drawings fit beside.
    const meta: Record<string, unknown> = {
      ...(rendered ? { [HTML_META_KEY]: rendered.html } : {}),
      // The whole note, for editing in the view; a note too long to show whole is not edited there.
      ...(note && !note.truncated ? { [SOURCE_META_KEY]: content } : {}),
      ...(modules ? { [COMPONENTS_META_KEY]: { modules, ...(editors ? { editors } : {}) } } : {}),
    }
    const { embeds, svgs, diagrams } =
      refs.length > 0 ? await drawEmbeds(supabase, project_id, refs, roomBeside(meta), { [data.path]: content }) : { embeds: [], svgs: {}, diagrams: {} }
    if (Object.keys(svgs).length > 0) meta[SVG_META_KEY] = svgs
    if (Object.keys(diagrams).length > 0) meta[D2_META_KEY] = diagrams
    return {
      content: [
        {
          type: 'text',
          text:
            made === 'created'
              ? `Created ${data.path} (version ${data.version}) and showed it to the user. Open it in elaborat.ing: ${url}`
              : made === 'updated'
                ? `Saved ${data.path} as version ${data.version} and showed it to the user. Open it in elaborat.ing: ${url}`
                : `Showing ${data.path} (version ${data.version}) to the user. Open it in elaborat.ing: ${url}`,
        },
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
        ...(modules ? { shared } : {}),
      },
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    }
  } catch (error) {
    return runtimeErrorResult(error)
  }
}

/**
 * card_embed's result: the drawing or diagram at `path` as show_file draws it
 * shown on its own, read as the user with the same limits, for the view to
 * show where a note's link to it was (`deferred`). Its SVG, or what the view
 * draws a diagram from, goes in structuredContent, not `_meta`: a host may
 * leave `_meta` out of the result of a call the view makes (ChatGPT left it
 * out of the result it passes the view until May 2026). Only the view calls
 * this tool, so the model never reads its result.
 */
export async function cardEmbedPayload({ supabase }: ToolContext, project_id: string, path: string): Promise<CallToolResult> {
  const kind = fileKind(path)
  if (kind !== 'drawing' && kind !== 'diagram') return errorResult(`${path} is not a drawing or a diagram.`)
  try {
    const { data, error } = await supabase.from('project_files').select('path, content').eq('project_id', project_id).eq('path', path).maybeSingle()
    if (error) throw error
    if (!data) return noFile(path)
    const drawn = await drawEmbeds(supabase, project_id, [{ kind, path: data.path }], ALONE, { [data.path]: String(data.content ?? '') })
    const svg = drawn.svgs[data.path]
    const diagram = drawn.diagrams[data.path]
    return {
      content: [{ type: 'text', text: `Sent ${data.path} to the card that shows it.` }],
      structuredContent: { path: data.path, status: drawn.embeds[0].status, ...(svg ? { svg } : {}), ...(diagram ? { diagram } : {}) },
    }
  } catch (error) {
    return runtimeErrorResult(error)
  }
}

export function registerFileView(server: McpServer, context: ToolContext): void {
  for (const [index, uri] of [FILE_VIEW_URI, ...OLD_FILE_VIEW_URIS].entries()) {
    server.registerResource(
      index === 0 ? 'file_view' : `file_view_${index}`,
      uri,
      {
        title: 'File view',
        description:
          'A view of one file with a link to open it in elaborat.ing; notes can be edited in it, and components are previewed. ' +
          'Used by show_file, preview_component, create_and_show and update_and_show.',
        mimeType: MCP_APP_MIME_TYPE,
      },
      () => ({
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: FILE_VIEW_HTML,
            // The view draws its own card, so the host adds no frame of its own.
            _meta: FILE_VIEW_META,
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ...VIEW_CALLABLE, ui: { ...VIEW_CALLABLE.ui, resourceUri: FILE_VIEW_URI } },
    },
    ({ project_id, path }) => showFilePayload(context, project_id, path)
  )

  server.registerTool(
    'create_and_show',
    {
      title: 'Create and show',
      description:
        'Create a new note (.mdx or .md), drawing (.excalidraw) or diagram (.d2) and show it to the user in the chat as a card, ' +
        'which draws it while you write it where the chat allows that. It only creates: a file already at the path is not changed. ' +
        'Use it when the user should watch a new note, drawing or diagram being made. ' +
        "Write a drawing in draw's short form, a fraction of the full JSON to write: give a shape a label and leave out its size, " +
        "and join two shapes with an arrow's from and to, its label a word or two. It is saved as the full elements draw would make: the shape sized to its label, " +
        'the label a text bound to it, and the arrow placed and bound. ' +
        'To change a file, read it and use update_and_show, or write_file for a quiet change, with base_version.',
      inputSchema: z.object({
        project_id: projectId,
        path,
        content: z.string().describe('The complete content of the new file.'),
        mutation_id: mutationId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      // The model's tool only: the view never calls it.
      _meta: { ui: { resourceUri: FILE_VIEW_URI, visibility: ['model'] } },
    },
    async ({ project_id, path, content, mutation_id }) => {
      if (!SHOWN_AS_MADE.test(path)) return errorResult('Use write_file for this file.')
      try {
        // A put without base_version only creates: the database refuses it where a file exists.
        const { data, error } = await context.supabase.rpc('save_files', {
          project_id,
          mutation_id: mutation_id ?? crypto.randomUUID(),
          changes: [{ op: 'put', path, content: completeFile(path, content) }],
        })
        if (error) throw error
        if (data?.status === 'conflict') {
          return errorResult(`A file already exists at ${path}. Nothing was saved. To change it, read it and use update_and_show or write_file with base_version.`)
        }
        return await showFilePayload(context, project_id, path, { made: 'created' })
      } catch (error) {
        if (error instanceof DrawError) return errorResult(error.message)
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'update_and_show',
    {
      title: 'Change and show',
      description:
        'Change a note (.mdx or .md), drawing (.excalidraw) or diagram (.d2) and show it to the user in the chat as a card, ' +
        'which shows the change while you write it where the chat allows that: what stays shows at once, and what changes comes in. ' +
        'Read the file first and pass the version you read as base_version, with the complete new content. ' +
        'It saves as write_file does: if the result status is "conflict", someone changed the file first: read it again, merge, and retry. ' +
        'Use it when the user should watch the change happen. For quiet changes, and for files the user is not watching ' +
        '(components, code, many files at once), use write_file.',
      inputSchema: z.object({
        project_id: projectId,
        path,
        base_version: baseVersion,
        content: z.string().describe('The complete new content of the file.'),
        mutation_id: mutationId,
      }),
      // It overwrites the file, so it is destructive, as write_file is.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      // The model's tool only: the view never calls it.
      _meta: { ui: { resourceUri: FILE_VIEW_URI, visibility: ['model'] } },
    },
    async ({ project_id, path, base_version, content, mutation_id }) => {
      if (!SHOWN_AS_MADE.test(path)) return errorResult('Use write_file for this file.')
      try {
        // The same save as write_file's: a put with the version the agent read.
        const { data, error } = await context.supabase.rpc('save_files', {
          project_id,
          mutation_id: mutation_id ?? crypto.randomUUID(),
          changes: [{ op: 'put', path, content: completeFile(path, content), base_version }],
        })
        if (error) throw error
        if (data?.status === 'conflict') {
          const current = (data.conflicts as Array<{ current?: { version?: number } | null }> | undefined)?.[0]?.current
          // A version for a file that is not there: nothing to change.
          if (!current) return errorResult(`No file at ${path} in this project. Nothing was saved. To make a new file, use create_and_show.`)
          // write_file's conflict result, after a line the card shows the person.
          return {
            content: [
              { type: 'text', text: `Someone changed ${path} first: it is now version ${current.version}. Nothing was saved. Read it again, merge, and retry.` },
              { type: 'text', text: JSON.stringify(data) },
            ],
            structuredContent: data,
          }
        }
        return await showFilePayload(context, project_id, path, { made: 'updated' })
      } catch (error) {
        if (error instanceof DrawError) return errorResult(error.message)
        return runtimeErrorResult(error)
      }
    }
  )

  // How a live card went, from the card itself, once it settles: which host,
  // whether it sent the input as it was written (partials) and when. One log
  // line of the function, read from its logs; nothing is stored, so it is
  // not destructive, and it is not read-only, since it logs.
  server.registerTool(
    'card_report',
    {
      title: 'Card report',
      description:
        'Used by the file view itself: reports how a card that showed a file as it was written went, for the server log. Not for use in a conversation.',
      inputSchema: z.object({
        host: z.string().min(1).max(40).describe("The host's name, as it gave it."),
        tool: z.enum(['create_and_show', 'update_and_show']),
        partials: z.number().int().min(0).max(1_000_000).describe('How many times the host sent the input so far.'),
        first_partial_ms: z.number().int().min(0).max(DAY_MS).nullable().describe('When the first came, in ms after the card started; null for none.'),
        total_ms: z.number().int().min(0).max(DAY_MS).describe('When the card settled, in ms after it started.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ host, tool, partials, first_partial_ms, total_ms }) => {
      console.log(JSON.stringify({ event: 'card_live', user: context.userClaims.id, host, tool, partials, first_partial_ms, total_ms }))
      return { content: [{ type: 'text', text: 'Noted.' }] }
    }
  )

  // For the view only: one drawing or diagram a note embeds that did not fit
  // in show_file's result, which the view loads to show where its link was.
  server.registerTool(
    'card_embed',
    {
      title: 'Card embed',
      description:
        "Used by the file view itself: one drawing or diagram a note embeds that did not fit in show_file's result, for the view to show. Not for use in a conversation.",
      inputSchema: z.object({ project_id: projectId, path }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ project_id, path }) => cardEmbedPayload(context, project_id, path)
  )
}
