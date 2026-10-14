import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { mutationId, path, projectId } from './projects.ts'
import { errorResult, jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// append_to_note: adds a section to the end of a note and saves, so the
// person watches the note being written in the app and in its panel beside
// the chat, which take each save through Realtime and write the added part
// in. Nothing can show while a model writes one tool call, and ChatGPT sends
// no partial input, so a note written in one write_file appears all at once
// when it is saved.
//
// It only adds, so it is not destructive: the note's text stays as it is,
// apart from the whitespace at its end, which the join replaces. The text
// goes after it with exactly one blank line between, and the note ends with
// one line break. The save is write_file's: save_files with the version it
// read. When someone saved the note in between, it reads it again and adds
// once more, since an addition at the end goes on top of their change. A
// mutation_id that already saved this text is answered with that save.

/** The notes this tool adds to. */
const NOTE = /\.mdx?$/i
/** Obsidian's drawings end in .md too; write_file changes them. */
const OBSIDIAN_DRAWING = /\.excalidraw\.md$/i

/** The most text one call adds, in characters: a section, such as a heading and its paragraphs. */
export const MAX_APPEND_CHARS = 4000

/** Why a path is not a note this tool adds to, and the tool that changes it. */
function notANote(path: string): string {
  if (OBSIDIAN_DRAWING.test(path)) {
    return 'append_to_note adds to notes. An Obsidian drawing (.excalidraw.md) is changed with write_file: read it, then save it with base_version.'
  }
  if (/\.excalidraw$/i.test(path)) return 'append_to_note adds to notes (.md or .mdx). To add to a drawing, use draw.'
  if (/\.d2$/i.test(path)) return 'append_to_note adds to notes (.md or .mdx). To change a diagram, read it and use write_file with base_version.'
  return 'append_to_note adds to notes (.md or .mdx). To change another file, read it and use write_file with base_version.'
}

/**
 * The text as it is added: without blank lines before it, so exactly one
 * separates it from the note, and without whitespace after it.
 */
export function section(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
}

/** The note with `added` at its end: its trailing whitespace trimmed, one blank line, `added` and one line break. */
export function appendText(content: string, added: string): string {
  const kept = content.trimEnd()
  return `${kept === '' ? '' : `${kept}\n\n`}${added}\n`
}

export function registerAppendToNote(server: McpServer, { supabase }: ToolContext): void {
  server.registerTool(
    'append_to_note',
    {
      title: 'Add to note',
      description:
        'Add text to the end of a note (.md or .mdx) and save it, creating the note if there is none at the path. ' +
        "The text goes after the note's last line with exactly one blank line between them: the note's trailing whitespace " +
        'is trimmed first, and the note then ends with one line break. ' +
        'Each call saves, and the user sees the new text come in, in elaborat.ing and in its panel beside the chat. ' +
        'To let them watch a note being written, call this several times, a section each (a heading and its paragraphs), ' +
        'in reading order, not one big write_file. It only adds: nothing already in the note changes. ' +
        'To change or remove text, read the note and use write_file with base_version. ' +
        "Returns the note's new version, the characters added and the note's new length.",
      inputSchema: z.object({
        project_id: projectId,
        path: path.describe('The note, such as notes/plan.mdx. It is created if it does not exist.'),
        text: z
          .string()
          .min(1)
          .max(MAX_APPEND_CHARS)
          .describe(
            "The text to add, in the note's format: Markdown, or MDX in a .mdx note. At most 4,000 characters, so write a " +
              'long note a section at a time. Keep each block (a list, a table, a code block, a component) whole in one call.'
          ),
        base_version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional. The version you last read or that append_to_note returned: if the note changed since, nothing is saved.'),
        mutation_id: mutationId,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, path, text, base_version, mutation_id }) => {
      if (!NOTE.test(path) || OBSIDIAN_DRAWING.test(path)) return errorResult(notANote(path))
      const added = section(text)
      if (added === '') return errorResult('The text is only whitespace. Nothing was saved. Pass the section to add.')
      const read = async () => {
        const { data, error } = await supabase
          .from('project_files')
          .select('content, version')
          .eq('project_id', project_id)
          .eq('path', path)
          .maybeSingle()
        if (error) throw error
        return data ? { content: String(data.content ?? ''), version: Number(data.version) } : null
      }
      try {
        if (mutation_id) {
          // A retry of a call that saved: its save, not the text added twice.
          // The id names the versions its save made (file_versions).
          const { data, error } = await supabase
            .from('file_versions')
            .select('path, version, content')
            .eq('project_id', project_id)
            .eq('mutation_id', mutation_id)
          if (error) throw error
          const saves = (data ?? []) as { path: string; version: number; content: string | null }[]
          if (saves.length > 0) {
            const same = saves.find((save) => save.path === path && save.content?.endsWith(`${added}\n`))
            if (!same?.content) {
              return errorResult(`The mutation_id ${mutation_id} was already used for a different change. Nothing was saved. Use a new mutation_id for new text.`)
            }
            return jsonResult({ path, version: Number(same.version), added: added.length, length: same.content.length })
          }
        }
        let note = await read()
        if (base_version !== undefined && note?.version !== base_version) {
          return errorResult(
            note
              ? `${path} changed since version ${base_version}: it is now version ${note.version}. Nothing was saved. ` +
                  'Read it again, or call append_to_note without base_version to add to it as it is.'
              : `No note at ${path}. Nothing was saved. Call append_to_note without base_version to create it.`
          )
        }
        for (let attempt = 1; ; attempt++) {
          const content = appendText(note?.content ?? '', added)
          const { data, error } = await supabase.rpc('save_files', {
            project_id,
            mutation_id: mutation_id ?? crypto.randomUUID(),
            changes: [{ op: 'put', path, content, ...(note ? { base_version: note.version } : {}) }],
          })
          if (error) throw error
          if (data?.status !== 'conflict') {
            return jsonResult({ path, version: data?.changes?.[0]?.version ?? null, added: added.length, length: content.length })
          }
          // Someone saved the note in between. Added to the note as it is now,
          // the text goes after their change, so it is added once more; a
          // note changed since base_version is the caller's to look at.
          const current = data.conflicts?.[0]?.current?.version
          if (base_version !== undefined || attempt === 2) {
            return errorResult(
              `${path} changed while the text was being added${current ? `: it is now version ${current}` : ''}. Nothing was saved. ` +
                (base_version !== undefined ? 'Read it again, or call append_to_note without base_version.' : 'Call append_to_note again.')
            )
          }
          note = await read()
        }
      } catch (error) {
        return runtimeErrorResult(error)
      }
    }
  )
}
