import type { CallToolResult, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import {
  type CommentAnchor,
  elementLabel,
  placeAnchor,
  sectionAnchor,
  textAnchor,
} from '../../_shared/comments/placement.ts'
import { parseDrawing } from '../../_shared/drawing.ts'
import { type NoteHeading, noteHeadings } from '../../_shared/passages.ts'
import { path, projectId } from './projects.ts'
import { errorResult, jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Comments, as the user: list them, start a thread, reply, and resolve or
// reopen. Each tool is a thin wrapper around the database functions
// (supabase/schemas/comments.sql). The agent describes an anchor in plain
// terms (text copied from the file, a heading, or a drawing element) and the
// tool turns it into the selectors the app stores, with the app's own code
// (../../_shared/comments/). Listing finds each thread again in the saved
// file. There are no tools to edit or delete a comment: agents resolve, and
// the database refuses their edits and deletes anyway.

type Person = { user_id: string; email: string | null } | null

/** A comment as list_comments returns it. */
type RemoteComment = {
  id: string
  author: Person
  via_agent: boolean
  body: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

/** A thread as list_comments returns it. */
type RemoteThread = {
  id: string
  file_id: string
  path: string
  file_deleted: boolean
  file_version: number
  anchor: CommentAnchor
  created_at: string
  resolved_at: string | null
  resolved_by: Person
  comments: RemoteComment[]
}

type SavedFile = { id: string; path: string; content: string; version: number }

const isDrawing = (file: string) => /\.excalidraw(\.md)?$/i.test(file)
const isNote = (file: string) => !isDrawing(file) && /\.mdx?$/i.test(file)
const isDiagram = (file: string) => /\.d2$/i.test(file)

/** What a thread is placed against: a saved file's text, its headings, or its drawing's live elements. */
type FileView = { source?: string; headings: NoteHeading[]; liveElementIds?: ReadonlySet<string> }

function fileView(file: SavedFile): FileView {
  if (!isDrawing(file.path)) return { source: file.content, headings: noteHeadings(file.path, file.content) }
  let ids: string[] = []
  try {
    ids = parseDrawing(file.content).map((element) => String(element.id))
  } catch {
    // A drawing that cannot be read has no elements to attach to.
  }
  return { headings: [], liveElementIds: new Set(ids) }
}

const lineNumber = (source: string, offset: number) => source.slice(0, offset).split('\n').length

/** A thread for the agent: whether it is still attached, where, and its comments. */
function presentThread(thread: RemoteThread, view: FileView | null) {
  const { anchor } = thread
  const placement = view && !thread.file_deleted ? placeAnchor(anchor, view) : { status: 'detached' as const }
  const attached = placement.status === 'attached'
  let described: Record<string, unknown>
  switch (anchor.kind) {
    case 'document':
      described = { kind: 'document' }
      break
    case 'element':
      described = { kind: 'element', element_id: anchor.element_id, label: anchor.label, ...(anchor.point ? { point: anchor.point } : {}) }
      break
    default: {
      const range = placement.status === 'attached' ? placement.range : undefined
      const source = view?.source
      if (!range || source === undefined) {
        described = anchor.kind === 'section'
          ? { kind: 'section', heading: anchor.quote.exact }
          : { kind: 'text', original_quote: anchor.quote.exact }
      } else if (anchor.kind === 'section') {
        const heading = view?.headings.find((candidate) => candidate.start <= range.start && range.start <= candidate.end)
        described = { kind: 'section', heading: heading?.path ?? source.slice(range.start, range.end), line: lineNumber(source, range.start) }
      } else {
        const quote = source.slice(range.start, range.end)
        described = {
          kind: 'text',
          quote,
          line: lineNumber(source, range.start),
          ...(quote !== anchor.quote.exact ? { original_quote: anchor.quote.exact } : {}),
        }
      }
    }
  }
  return {
    thread_id: thread.id,
    attached,
    resolved: thread.resolved_at !== null,
    ...(thread.file_deleted ? { file_deleted: true } : {}),
    anchor: described,
    comments: thread.comments.map(presentComment),
  }
}

function presentComment(comment: RemoteComment) {
  return {
    comment_id: comment.id,
    author: comment.author?.email ?? null,
    via_agent: comment.via_agent,
    body: comment.body,
    created_at: comment.created_at,
    edited_at: comment.edited_at,
    deleted: comment.deleted_at !== null,
  }
}

const threadId = z.uuid().describe('The thread id, from list_comments.')
const body = z.string().min(1).max(5000).describe('The comment, 1 to 5000 characters.')

export function registerCommentTools(server: McpServer, { supabase }: ToolContext): void {
  const readFile = async (project: string, file: string): Promise<SavedFile | null> => {
    const { data, error } = await supabase
      .from('project_files')
      .select('id, path, content, version')
      .eq('project_id', project)
      .eq('path', file)
      .maybeSingle()
    if (error) throw error
    return data as SavedFile | null
  }

  const listThreads = async (project: string, fileId?: string): Promise<RemoteThread[]> => {
    const { data, error } = await supabase.rpc('list_comments', { project_id: project, ...(fileId ? { file_id: fileId } : {}) })
    if (error) throw error
    return (data as { threads: RemoteThread[] }).threads
  }

  server.registerTool(
    'list_comments',
    {
      description:
        'List the comments in a project. Without path, returns how many open and resolved threads each file has. ' +
        'With path, returns that file\'s threads, each found again in the saved file: attached says whether its text, ' +
        'heading or element is still there, and anchor says where (the quoted text and its line, a note\'s heading, ' +
        'a drawing element, or the whole file). A thread\'s first comment opens it; the rest are replies. ' +
        'Resolved threads are left out unless include_resolved is true. A deleted file\'s threads are listed by its last path.',
      inputSchema: z.object({
        project_id: projectId,
        path: path.optional().describe('A file to read the threads of, such as notes/plan.md. Leave it out for counts per file.'),
        include_resolved: z.boolean().optional().describe('Include resolved threads. Defaults to false.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project_id, path, include_resolved }) => {
      try {
        if (path === undefined) {
          const files = new Map<string, { path: string; file_deleted: boolean; open: number; resolved: number }>()
          for (const thread of await listThreads(project_id)) {
            const entry = files.get(thread.file_id) ?? { path: thread.path, file_deleted: thread.file_deleted, open: 0, resolved: 0 }
            entry[thread.resolved_at === null ? 'open' : 'resolved']++
            files.set(thread.file_id, entry)
          }
          const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(a.file_deleted) - Number(b.file_deleted)))
          return jsonResult({ files: sorted })
        }
        const file = await readFile(project_id, path)
        const threads = file
          ? await listThreads(project_id, file.id)
          : (await listThreads(project_id)).filter((thread) => thread.path === path && thread.file_deleted)
        if (!file && threads.length === 0) return errorResult(`No file at ${path} in this project.`)
        const view = file ? fileView(file) : null
        return jsonResult({
          path,
          version: file?.version ?? null,
          threads: threads
            .filter((thread) => include_resolved || thread.resolved_at === null)
            .map((thread) => presentThread(thread, view)),
        })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'add_comment',
    {
      description:
        'Start a comment thread on a file, as the user. Anchor it with one of: quote (text copied exactly from the ' +
        "file's source; add prefix or suffix when it appears more than once), heading (a note's heading, or its path " +
        'like "Guide > Setup"), or element_id (an element of a drawing; point optionally marks a spot on it as fractions ' +
        'of its width and height). With none, the comment is on the whole file. People who can read the project see it.',
      inputSchema: z.object({
        project_id: projectId,
        path,
        body,
        quote: z.string().min(1).max(5000).optional()
          .describe("Text to comment on, copied exactly from the file's source as read_file returns it, Markdown included."),
        prefix: z.string().optional().describe('Text right before quote, to pick one of several.'),
        suffix: z.string().optional().describe('Text right after quote, to pick one of several.'),
        heading: z.string().min(1).optional()
          .describe('A heading of a note (.md or .mdx), by its text or its path like "Guide > Setup", to comment on its section.'),
        element_id: z.string().min(1).max(256).optional().describe("A drawing element's id, from the drawing's elements."),
        point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional()
          .describe('A spot on the element, as fractions of its width and height from its top-left corner.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      const { project_id, path, body, quote, prefix, suffix, heading, element_id, point } = input
      if ([quote, heading, element_id].filter((anchor) => anchor !== undefined).length > 1) {
        return errorResult('Give at most one of quote, heading and element_id.')
      }
      if ((prefix !== undefined || suffix !== undefined) && quote === undefined) {
        return errorResult('prefix and suffix pick one occurrence of quote; give quote too.')
      }
      if (point !== undefined && element_id === undefined) return errorResult('point marks a spot on an element; give element_id too.')
      if (quote !== undefined && isDrawing(path)) {
        return errorResult(`${path} is a drawing: comment on one of its elements with element_id, or on the whole drawing with no anchor.`)
      }
      if (heading !== undefined && !isNote(path)) {
        return errorResult(`Only notes (.md and .mdx) have headings. Use quote to comment on text in ${path}.`)
      }
      if (element_id !== undefined && isDiagram(path)) {
        return errorResult(`Diagram elements are in its canvas: use path ${path.replace(/\.d2$/i, '.excalidraw')}.`)
      }
      if (element_id !== undefined && !isDrawing(path)) {
        return errorResult(`${path} is not a drawing. Use quote to comment on its text.`)
      }

      try {
        const file = await readFile(project_id, path)
        if (!file) return errorResult(`No file at ${path} in this project. Use list_files to see what exists.`)

        let anchor: CommentAnchor = { kind: 'document' }
        if (quote !== undefined) {
          const found = findQuote(path, file.content, quote, prefix ?? '', suffix ?? '')
          if (typeof found === 'string') return errorResult(found)
          anchor = textAnchor(file.content, found, found + quote.length)
        } else if (heading !== undefined) {
          const found = findHeading(path, noteHeadings(path, file.content), heading)
          if (typeof found === 'string') return errorResult(found)
          try {
            anchor = sectionAnchor(file.content, found.start)
          } catch {
            return errorResult(`That heading cannot take a section comment. Use quote to comment on its text.`)
          }
        } else if (element_id !== undefined) {
          let elements
          try {
            elements = parseDrawing(file.content)
          } catch {
            return errorResult(`${path} could not be read as a drawing.`)
          }
          const label = elementLabel(elements, element_id)
          if (label === null) return errorResult(`No element ${element_id} in ${path}. Read the file for its elements' ids.`)
          anchor = { kind: 'element', element_id, label, ...(point ? { point } : {}) }
        }

        const { data, error } = await supabase.rpc('add_comment', {
          project_id,
          thread_id: crypto.randomUUID(),
          file_id: file.id,
          file_version: file.version,
          anchor,
          body,
        })
        if (error) throw error
        const { thread } = data as { thread: RemoteThread }
        return jsonResult({ path, version: file.version, thread: presentThread(thread, fileView(file)) })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'reply_comment',
    {
      description: 'Reply to a comment thread, as the user. People who can read the project see it.',
      inputSchema: z.object({ thread_id: threadId, body }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ thread_id, body }) => {
      try {
        const { data, error } = await supabase.rpc('reply_comment', { thread_id, comment_id: crypto.randomUUID(), body })
        if (error) throw error
        return jsonResult({ thread_id, comment: presentComment((data as { comment: RemoteComment }).comment) })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )

  server.registerTool(
    'resolve_comment',
    {
      description: 'Resolve a comment thread once it is dealt with, or reopen it with resolved false. Anyone who can comment can do either.',
      inputSchema: z.object({
        thread_id: threadId,
        resolved: z.boolean().optional().describe('false reopens the thread. Defaults to true.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ thread_id, resolved }) => {
      try {
        const { data, error } = await supabase.rpc(resolved === false ? 'reopen_comment' : 'resolve_comment', { thread_id })
        if (error) throw error
        const { thread } = data as { thread: RemoteThread }
        return jsonResult({ thread_id, path: thread.path, resolved: thread.resolved_at !== null })
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}

/** Where `quote` is in `source`, preceded by `prefix` and followed by `suffix`, or why it cannot be picked. */
function findQuote(file: string, source: string, quote: string, prefix: string, suffix: string): number | string {
  const all: number[] = []
  for (let at = source.indexOf(quote); at !== -1; at = source.indexOf(quote, at + 1)) all.push(at)
  if (all.length === 0) {
    return `That quote is not in ${file}. Copy it exactly from the file's source, as read_file returns it, Markdown included.`
  }
  const matches = all.filter(
    (at) => source.slice(at - prefix.length, at) === prefix && source.slice(at + quote.length, at + quote.length + suffix.length) === suffix
  )
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    return `That quote is in ${file}, but never with that prefix and suffix. Copy them exactly from the file's source.`
  }
  return `That quote appears ${matches.length} times in ${file}. Add prefix or suffix, the text right before or after it, to pick one.`
}

/** The heading `wanted` names, by its path first and then by its text, or why it cannot be picked. */
function findHeading(file: string, headings: NoteHeading[], wanted: string): NoteHeading | string {
  if (headings.length === 0) return `There are no headings in ${file}. Use quote to comment on its text.`
  const name = wanted.replace(/^\s*#+\s*/, '').trim()
  const byPath = headings.filter((heading) => heading.path === name)
  const matches = byPath.length > 0 ? byPath : headings.filter((heading) => heading.text === name)
  if (matches.length === 1) return matches[0]
  const listed = (matches.length > 1 ? matches : headings).slice(0, 20).map((heading) => JSON.stringify(heading.path)).join(', ')
  return matches.length > 1
    ? `"${name}" is ${matches.length} headings in ${file}. Give its path instead: ${listed}.`
    : `No heading "${name}" in ${file}. Its headings: ${listed}.`
}
