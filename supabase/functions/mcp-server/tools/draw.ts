import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { generateKeyBetween, generateNKeysBetween } from 'npm:fractional-indexing@3.2.0'
import { z } from 'npm:zod@4.4.3'

import { completeElements, DrawError, MAX_SIZED_WIDTH } from './drawingCompletion.ts'
import { path, projectId } from './projects.ts'
import { errorResult, jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// draw: adds a few elements to a drawing and saves, so the person watches it
// grow in the app and in its panel beside the chat, which take each save
// through Realtime. Nothing can show while a model writes one tool call, so a
// drawing written in one write_file appears all at once when it is saved.
//
// It only adds, so it is not destructive: every element needs a new id, and
// no element already in the drawing changes, except that a shape lists the
// labels and arrows bound to it in boundElements, as Excalidraw keeps them.
// Each element is completed as every write completes a drawing
// (drawingCompletion.ts): its label and its from and to become the full
// elements they stand for, and fields it leaves out get Excalidraw's
// defaults. Indices continue from the scene's last with Excalidraw's own
// fractional-indexing, so the app and drawingSvg.ts draw it as Excalidraw
// would. The save is write_file's: save_files with the version it read. When
// someone saved the drawing in between, it reads it again and adds once more.
//
// Each call costs the model several seconds however many elements it adds,
// and the app sketches each new element in turn, so a call adds several
// shapes at once, and its shortcuts spare the model the arithmetic.

/** Drawings this tool adds to. An Obsidian .excalidraw.md is changed with write_file. */
const DRAWING = /\.excalidraw$/i

const TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw'] as const

/** The most elements one call adds, labels included. */
const MAX_ADDED = 50

const binding = z.looseObject({ elementId: z.string().min(1) })
const element = z.looseObject({
  id: z.string().min(1),
  type: z.enum(TYPES),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  label: z.string().optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  text: z.string().optional(),
  points: z.array(z.array(z.number()).min(2)).optional(),
  containerId: z.string().nullable().optional(),
  startBinding: binding.nullable().optional(),
  endBinding: binding.nullable().optional(),
})

export type NewElement = z.infer<typeof element>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `count` indices after every valid one in the scene, in order. */
function nextIndices(elements: unknown[], count: number): string[] {
  let last: string | null = null
  for (const element of elements) {
    const index = isRecord(element) ? element.index : null
    if (typeof index !== 'string' || (last !== null && index <= last)) continue
    try {
      generateKeyBetween(index, null)
      last = index
    } catch {
      // Not a fractional index: Excalidraw gives that element a new one when it opens the drawing.
    }
  }
  return generateNKeysBetween(last, null, count)
}

/** A new drawing, in the shape the drawings skill writes one. */
const newScene = (): Record<string, unknown> => ({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} })

/**
 * The drawing's text with `elements` added after the ones it has, how many
 * elements that added (labels included) and how many live elements it then
 * has. `content` null (or empty) is a new drawing. Throws a DrawError, saving
 * nothing, for an id already used, a label or an arrow whose shape is not
 * there, or an element missing what it needs.
 */
export function addElements(
  content: string | null,
  elements: NewElement[],
  updated = Date.now()
): { content: string; added: number; elementCount: number } {
  let scene: Record<string, unknown>
  if (content === null || content.trim() === '') {
    scene = newScene()
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new DrawError('This file is not valid drawing JSON, so nothing was added. Fix it with write_file first.')
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.elements)) {
      throw new DrawError('This file has no elements list, so nothing was added. Fix it with write_file first.')
    }
    scene = parsed
  }
  const existing = scene.elements as unknown[]
  const { elements: all, added } = completeElements(existing, elements, {
    updated,
    indices: (count) => {
      if (count > MAX_ADDED) {
        throw new DrawError(
          `These elements come to ${count} with their labels, and draw adds at most ${MAX_ADDED} a call. Nothing was saved. Split them over more calls.`
        )
      }
      return nextIndices(existing, count)
    },
  })
  scene.elements = all
  const elementCount = all.filter((entry) => isRecord(entry) && entry.isDeleted !== true).length
  return { content: JSON.stringify(scene, null, 2), added, elementCount }
}

/** The description's example: two labelled boxes and an arrow between them. */
const EXAMPLE = [
  { id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API' },
  { id: 'db', type: 'rectangle', x: 300, y: 0, label: 'Database' },
  { id: 'api-to-db', type: 'arrow', from: 'api', to: 'db', label: 'SQL' },
]

export function registerDrawTool(server: McpServer, { supabase }: ToolContext): void {
  server.registerTool(
    'draw',
    {
      title: 'Draw',
      description:
        'Add elements to a drawing (.excalidraw) and save it, creating the drawing if there is none at the path. ' +
        'The user sees each new element sketched in turn, in elaborat.ing and in its panel beside the chat. ' +
        'Add several shapes per call, a row or a group of related shapes with their arrows, about 4 to 10 elements. ' +
        "Don't add one shape per call. " +
        "Give a shape a label and leave out its size, and join two shapes with an arrow's from and to: " +
        'draw sizes the shape to its label and places and binds the arrow. ' +
        `A long label wraps, so a shape sized to it is at most about ${MAX_SIZED_WIDTH} px wide: shapes 300 apart leave room for an arrow. ` +
        `For example, elements: ${JSON.stringify(EXAMPLE)}. ` +
        'It only adds: each element needs a new id. To change or remove elements, use write_file once with base_version, then draw what is new.',
      inputSchema: z.object({
        project_id: projectId,
        path: path.describe('The drawing, such as drawings/flow.excalidraw. It is created if it does not exist.'),
        elements: z
          .array(element)
          .min(1)
          .max(MAX_ADDED)
          .describe(
            'The elements to add, in drawing order, each with a new id and a type. ' +
              'A rectangle, ellipse or diamond needs x and y; with a label, its width and height may be left out, and it is sized to fit the label. ' +
              'An arrow needs only from and to, the ids of two shapes in the drawing or in this call, and may have a label. ' +
              `A label becomes a text with the id "<id>-label". At most ${MAX_ADDED} elements a call, labels included. ` +
              'Full Excalidraw elements work too: text needs x, y and text; lines, and arrows without from and to, need x, y and points relative to them. ' +
              'A text with containerId set to a shape or arrow is its label, and draw centres it there; an arrow attaches with startBinding and endBinding ({"elementId": "..."}).'
          ),
        base_version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional. The version you last read or that draw returned: if the drawing changed since, nothing is saved.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, path, elements, base_version }) => {
      if (!DRAWING.test(path)) {
        return errorResult(
          /\.excalidraw\.md$/i.test(path)
            ? 'draw adds to .excalidraw drawings. To change an Obsidian .excalidraw.md drawing, read it and use write_file with base_version.'
            : 'draw adds to drawings: use a path that ends in .excalidraw.'
        )
      }
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
        let file = await read()
        if (base_version !== undefined && file?.version !== base_version) {
          return errorResult(
            file
              ? `${path} changed since version ${base_version}: it is now version ${file.version}. Nothing was saved. ` +
                  'Read it again, or call draw without base_version to add to it as it is.'
              : `No drawing at ${path}. Nothing was saved. Call draw without base_version to create it.`
          )
        }
        for (let attempt = 1; ; attempt++) {
          const next = addElements(file?.content ?? null, elements)
          const { data, error } = await supabase.rpc('save_files', {
            project_id,
            mutation_id: crypto.randomUUID(),
            changes: [{ op: 'put', path, content: next.content, ...(file ? { base_version: file.version } : {}) }],
          })
          if (error) throw error
          if (data?.status !== 'conflict') {
            return jsonResult({ path, version: data?.changes?.[0]?.version ?? null, added: next.added, element_count: next.elementCount })
          }
          // Someone saved the drawing in between. Added to as it is now, the
          // elements merge cleanly, so they are added once more; a drawing
          // changed since base_version is the caller's to look at.
          const current = data.conflicts?.[0]?.current?.version
          if (base_version !== undefined || attempt === 2) {
            return errorResult(
              `${path} changed while the elements were being added${current ? `: it is now version ${current}` : ''}. Nothing was saved. ` +
                (base_version !== undefined ? 'Read it again, or call draw without base_version.' : 'Call draw again.')
            )
          }
          file = await read()
        }
      } catch (error) {
        if (error instanceof DrawError) return errorResult(error.message)
        return runtimeErrorResult(error)
      }
    }
  )
}
