import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { generateKeyBetween, generateNKeysBetween } from 'npm:fractional-indexing@3.2.0'
import { z } from 'npm:zod@4.4.3'

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
// Fields an element leaves out get the defaults Excalidraw 0.18.1 gives a new
// element, and indices continue from the scene's last with Excalidraw's own
// fractional-indexing, so the app and drawingSvg.ts draw it as Excalidraw
// would. The save is write_file's: save_files with the version it read. When
// someone saved the drawing in between, it reads it again and adds once more.

/** Drawings this tool adds to. An Obsidian .excalidraw.md is changed with write_file. */
const DRAWING = /\.excalidraw$/i

const TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw'] as const
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
/** What a label can sit in (Excalidraw's text containers). */
const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow'])
/** What an arrow cannot attach to. */
const UNBINDABLE = new Set(['arrow', 'line', 'freedraw'])

/** Excalidraw's line height for each font family (0.18.1); 1.25 for any other. */
const LINE_HEIGHT: Record<number, number> = { 1: 1.25, 2: 1.15, 3: 1.2, 5: 1.25, 6: 1.35, 7: 1.15, 8: 1.25, 9: 1.15 }

const binding = z.looseObject({ elementId: z.string().min(1) })
const element = z.looseObject({
  id: z.string().min(1),
  type: z.enum(TYPES),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional(),
  points: z.array(z.array(z.number()).min(2)).optional(),
  containerId: z.string().nullable().optional(),
  startBinding: binding.nullable().optional(),
  endBinding: binding.nullable().optional(),
})

export type NewElement = z.infer<typeof element>
type Element = Record<string, unknown> & { id: string; type: string }
type Point = [number, number]

/** Why the elements cannot be added. Nothing is saved, and the message goes back to the model. */
class DrawError extends Error {}

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const round2 = (value: number) => Math.round(value * 100) / 100
const randomInteger = () => Math.floor(Math.random() * 2 ** 31)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The box points cover, as Excalidraw sizes a line from its points. */
function pointsSize(points: Point[]): { width: number; height: number } {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** One new element with every field Excalidraw gives a new one, those it was given kept. */
function complete(input: NewElement, index: string, updated: number): Element {
  const { id, type } = input
  const given = input as Record<string, unknown>
  let specific: Record<string, unknown> = {}
  let size: { width: number; height: number } | null = null

  if (SHAPES.has(type)) {
    if (!(num(input.width, 0) > 0 && num(input.height, 0) > 0)) throw new DrawError(`The ${type} "${id}" needs a width and a height above 0.`)
  } else if (type === 'text') {
    const text = input.text ?? ''
    if (text.trim() === '') throw new DrawError(`The text "${id}" needs some text.`)
    const fontFamily = num(given.fontFamily, 5)
    const fontSize = num(given.fontSize, 20)
    const lineHeight = num(given.lineHeight, LINE_HEIGHT[fontFamily] ?? 1.25)
    const bound = typeof input.containerId === 'string'
    specific = {
      text,
      fontSize,
      fontFamily,
      textAlign: bound ? 'center' : 'left',
      verticalAlign: bound ? 'middle' : 'top',
      containerId: null,
      originalText: text,
      autoResize: true,
      lineHeight,
    }
    // Excalidraw measures text with its font; this is near enough until it does.
    const lines = text.split('\n')
    size = {
      width: round2(Math.max(...lines.map((line) => [...line].length)) * fontSize * 0.55),
      height: round2(lines.length * fontSize * lineHeight),
    }
  } else {
    // A line or arrow with no points runs from x, y across its box, as Excalidraw restores one.
    const points = (input.points as Point[] | undefined) ??
      (type !== 'freedraw' && input.width !== undefined && input.height !== undefined ? [[0, 0], [input.width, input.height]] as Point[] : [])
    if (points.length < (type === 'freedraw' ? 1 : 2)) {
      throw new DrawError(`The ${type} "${id}" needs points, relative to its x and y, such as [[0, 0], [120, 0]].`)
    }
    size = pointsSize(points)
    specific = type === 'freedraw'
      ? { points, pressures: [], simulatePressure: true, lastCommittedPoint: null }
      : {
          points,
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: type === 'arrow' ? 'arrow' : null,
          ...(type === 'arrow' ? { elbowed: false } : {}),
        }
    // An arrow's attachments get the focus and gap Excalidraw keeps for each end.
    for (const end of ['startBinding', 'endBinding'] as const) {
      const attached = input[end]
      if (type === 'arrow' && attached) specific[end] = { focus: 0, gap: 8, ...attached }
    }
  }

  const completed: Element = {
    id,
    type,
    x: input.x,
    y: input.y,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    isDeleted: false,
    boundElements: [],
    updated,
    link: null,
    locked: false,
    ...specific,
    ...given,
  }
  // Each in turn after the scene's last element, whatever index it was given.
  completed.index = index
  for (const end of ['startBinding', 'endBinding'] as const) {
    if (specific[end]) completed[end] = specific[end]
  }
  return completed
}

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
 * The drawing's text with `elements` added after the ones it has, and how
 * many live elements it then has. `content` null (or empty) is a new drawing.
 * Throws a DrawError, saving nothing, for an id already used, a label or an
 * arrow whose shape is not there, or an element missing what it needs.
 */
/**
 * A label where Excalidraw keeps a centred one: the middle of its shape, or
 * the middle of its arrow's path (its middle point, or the middle of its
 * middle segment). The x and y it was sent don't matter, so an agent never
 * has to work them out.
 */
function placeLabel(label: Element, container: Element): void {
  let centre: Point
  if (container.type === 'arrow') {
    const points = (container.points as Point[] | undefined) ?? [[0, 0]]
    const half = Math.floor(points.length / 2)
    const [mx, my] = points.length % 2 === 1
      ? points[half]
      : [(points[half - 1][0] + points[half][0]) / 2, (points[half - 1][1] + points[half][1]) / 2]
    centre = [num(container.x, 0) + mx, num(container.y, 0) + my]
  } else {
    centre = [num(container.x, 0) + num(container.width, 0) / 2, num(container.y, 0) + num(container.height, 0) / 2]
  }
  label.x = round2(centre[0] - num(label.width, 0) / 2)
  label.y = round2(centre[1] - num(label.height, 0) / 2)
}

export function addElements(content: string | null, elements: NewElement[], updated = Date.now()): { content: string; elementCount: number } {
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

  const used = new Set(existing.map((entry) => (isRecord(entry) ? entry.id : undefined)))
  const named = new Set<string>()
  for (const { id } of elements) {
    if (used.has(id)) throw new DrawError(`The drawing already has an element "${id}". Nothing was saved. Give each new element a new id; to change an element, use write_file.`)
    if (named.has(id)) throw new DrawError(`The id "${id}" is used twice. Nothing was saved. Give each new element its own id.`)
    named.add(id)
  }

  const indices = nextIndices(existing, elements.length)
  const added = elements.map((input, i) => complete(input, indices[i], updated))

  // A label and an arrow find their shapes among the live elements, in the
  // drawing or in this call, and each shape lists what is bound to it.
  const live = new Map<string, Element>()
  for (const entry of [...existing, ...added]) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.isDeleted !== true) live.set(entry.id, entry as Element)
  }
  const bound = new Map<string, { type: 'text' | 'arrow'; id: string }[]>()
  const bind = (from: Element, targetId: string, kind: 'text' | 'arrow') => {
    const target = live.get(targetId)
    const what = kind === 'text' ? `The label "${from.id}"` : `The arrow "${from.id}"`
    if (!target) {
      throw new DrawError(`${what} is bound to "${targetId}", which is not in the drawing. Nothing was saved. Add that shape first, or in the same call.`)
    }
    if (kind === 'text' ? !CONTAINERS.has(target.type) : UNBINDABLE.has(target.type)) {
      const may = kind === 'text' ? 'a rectangle, ellipse, diamond or arrow' : 'a shape or a text, not a line, arrow or freedraw'
      throw new DrawError(`${what} cannot be bound to the ${target.type} "${targetId}": it can be bound to ${may}. Nothing was saved.`)
    }
    bound.set(targetId, [...(bound.get(targetId) ?? []), { type: kind, id: from.id }])
  }
  for (const entry of added) {
    if (entry.type === 'text' && typeof entry.containerId === 'string') {
      bind(entry, entry.containerId, 'text')
      placeLabel(entry, live.get(entry.containerId)!)
    }
    if (entry.type !== 'arrow') continue
    for (const end of [entry.startBinding, entry.endBinding]) {
      if (isRecord(end) && typeof end.elementId === 'string') bind(entry, end.elementId, 'arrow')
    }
  }
  /** The element with what was bound to it listed, or the very same element when it lists all of it already. */
  const listing = <T>(entry: T): T => {
    if (!isRecord(entry) || entry.isDeleted === true || typeof entry.id !== 'string') return entry
    const listed: unknown[] = Array.isArray(entry.boundElements) ? entry.boundElements : []
    const missing = (bound.get(entry.id) ?? []).filter(({ id }, i, all) =>
      !listed.some((item) => isRecord(item) && item.id === id) && all.findIndex((other) => other.id === id) === i
    )
    return missing.length === 0 ? entry : ({ ...entry, boundElements: [...listed, ...missing] } as T)
  }

  scene.elements = [...existing.map(listing), ...added.map(listing)]
  const elementCount = (scene.elements as unknown[]).filter((entry) => isRecord(entry) && entry.isDeleted !== true).length
  return { content: JSON.stringify(scene, null, 2), elementCount }
}

export function registerDrawTool(server: McpServer, { supabase }: ToolContext): void {
  server.registerTool(
    'draw',
    {
      title: 'Draw',
      description:
        'Add elements to a drawing (.excalidraw) and save it, creating the drawing if there is none at the path. ' +
        'Each call saves, and the user sees the new elements draw in, in elaborat.ing and in its panel beside the chat. ' +
        'To let them watch a drawing being made or extended, call this several times with a few elements each, in reading order: ' +
        'a shape, its label, then its arrows. It only adds: each element needs a new id, and nothing in the drawing changes, ' +
        'except that a shape lists the labels and arrows bound to it. Fields you leave out get Excalidraw\'s defaults. ' +
        'To change or remove elements, use write_file once with base_version, then draw what is new.',
      inputSchema: z.object({
        project_id: projectId,
        path: path.describe('The drawing, such as drawings/flow.excalidraw. It is created if it does not exist.'),
        elements: z
          .array(element)
          .min(1)
          .max(50)
          .describe(
            'The elements to add, in drawing order, as Excalidraw elements: each with a new id, a type, x and y. ' +
              'Shapes need width and height, text needs text, and arrows and lines need points relative to x and y. ' +
              'A label is a text with containerId set to its shape or arrow; draw centres it there, so its x and y can be 0. An arrow attaches with startBinding and endBinding ' +
              '({"elementId": "..."}). The shapes they name may be in the drawing already or in this call.'
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
            return jsonResult({ path, version: data?.changes?.[0]?.version ?? null, added: elements.length, element_count: next.elementCount })
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
