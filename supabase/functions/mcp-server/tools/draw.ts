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
//
// Each call costs the model several seconds however many elements it adds,
// and the app sketches each new element in turn, so a call adds several
// shapes at once. Two shortcuts, like Excalidraw's element skeletons
// (convertToExcalidrawElements), spare the model the arithmetic: a shape or
// arrow may take a label, added as a text bound to it, and an arrow may name
// the two shapes it joins (from, to) instead of its points. Each becomes the
// full elements a call could send, so both forms are added the same way.

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

/** The most elements one call adds, labels included. */
const MAX_ADDED = 50
/** How far short of a shape's outline Excalidraw ends an arrow bound to it. */
const GAP = 8
/** A shape sized to its label is at least this big. */
const MIN_SIZE = { width: 140, height: 70 }
/** The room around a label in a shape sized to it: each side, and above and below. */
const LABEL_ROOM = { x: 20, y: 10 }
/** How much bigger than the box it holds a shape is: the largest box inside an ellipse is 1/√2 of it each way, inside a diamond half. */
const HOLDS: Record<string, number> = { rectangle: 1, ellipse: Math.SQRT2, diamond: 2 }

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

/** The box text takes. Excalidraw measures text with its font; this is near enough until it does. */
function textBox(text: string, fontSize: number, lineHeight: number): { width: number; height: number } {
  const lines = text.split('\n')
  return {
    width: round2(Math.max(...lines.map((line) => [...line].length)) * fontSize * 0.55),
    height: round2(lines.length * fontSize * lineHeight),
  }
}

/** A shape's size for its label: the label's box with room around it, inside the largest box the shape holds, and at least MIN_SIZE. */
function sizeFor(type: string, label: string): { width: number; height: number } {
  const box = textBox(label, 20, LINE_HEIGHT[5])
  const holds = HOLDS[type] ?? 1
  return {
    width: Math.max(MIN_SIZE.width, Math.ceil((box.width + 2 * LABEL_ROOM.x) * holds)),
    height: Math.max(MIN_SIZE.height, Math.ceil((box.height + 2 * LABEL_ROOM.y) * holds)),
  }
}

/** One new element with every field Excalidraw gives a new one, those it was given kept. */
function complete(input: NewElement, index: string, updated: number): Element {
  const { id, type } = input
  const given = input as Record<string, unknown>
  let specific: Record<string, unknown> = {}
  let size: { width: number; height: number } | null = null

  if (typeof input.x !== 'number' || typeof input.y !== 'number') {
    throw new DrawError(
      type === 'arrow'
        ? `The arrow "${id}" needs from and to, or x, y and points. Nothing was saved.`
        : `The ${type} "${id}" needs x and y. Nothing was saved.`
    )
  }
  if (SHAPES.has(type)) {
    if (!(num(input.width, 0) > 0 && num(input.height, 0) > 0)) {
      throw new DrawError(`The ${type} "${id}" needs a width and a height above 0, or a label to be sized to.`)
    }
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
    size = textBox(text, fontSize, lineHeight)
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

/** An arrow's two ends: the ids of the shapes it joins. */
type Ends = { from: string; to: string }
/**
 * An element a call adds: as it was sent, less label, from and to; the ends
 * of an arrow drawn between two shapes; and for a label draw makes, the
 * shape or arrow it is for.
 */
type Planned = { input: NewElement; ends: Ends | null; labelOf: string | null }

/**
 * What a call adds, in order: each element as sent and, right after a shape
 * or arrow with a label, the text bound to it, `<id>-label`. A labelled
 * shape with no width or height is sized to its label. Throws a DrawError
 * for a label or an end that an element cannot take.
 */
function plan(elements: NewElement[]): Planned[] {
  const planned: Planned[] = []
  for (const { label, from, to, ...input } of elements) {
    const { id, type } = input
    let ends: Ends | null = null
    if (from !== undefined || to !== undefined) {
      if (type !== 'arrow') throw new DrawError(`The ${type} "${id}" has from or to, which only an arrow takes. Nothing was saved.`)
      if (from === undefined || to === undefined) {
        throw new DrawError(`The arrow "${id}" needs both from and to: the ids of the two shapes it joins. Nothing was saved.`)
      }
      if (input.points !== undefined || input.startBinding || input.endBinding) {
        throw new DrawError(
          `The arrow "${id}" has from and to, and points or a binding as well. Nothing was saved. ` +
            'Give from and to without points, startBinding and endBinding, and draw works them out; or give those without from and to.'
        )
      }
      if (from === to) throw new DrawError(`The arrow "${id}" goes from "${from}" to itself. Nothing was saved. Give from and to two different shapes.`)
      ends = { from, to }
    }
    if (label !== undefined) {
      if (!CONTAINERS.has(type)) {
        throw new DrawError(
          `The ${type} "${id}" has a label, which only a rectangle, ellipse, diamond or arrow can hold. Nothing was saved.` +
            (type === 'text' ? ' Put the words in its text.' : '')
        )
      }
      if (label.trim() === '') throw new DrawError(`The label of the ${type} "${id}" is empty. Nothing was saved. Give it some text, or leave label out.`)
      if (SHAPES.has(type)) {
        const size = sizeFor(type, label)
        input.width ??= size.width
        input.height ??= size.height
      }
    }
    planned.push({ input, ends, labelOf: null })
    if (label !== undefined) {
      planned.push({ input: { id: `${id}-label`, type: 'text', x: 0, y: 0, text: label, containerId: id }, ends: null, labelOf: id })
    }
  }
  return planned
}

/** The middle of an element's box, which Excalidraw turns it around. */
const middle = (element: Element): Point => [num(element.x, 0) + num(element.width, 0) / 2, num(element.y, 0) + num(element.height, 0) / 2]

/**
 * How far a shape's outline is from its middle in the direction (dx, dy), a
 * unit vector: the outline of a rectangle, an ellipse or a diamond, turned
 * with the shape. Any other shape counts as its box.
 */
function reach(shape: Element, [dx, dy]: Point): number {
  const a = Math.abs(num(shape.width, 0)) / 2
  const b = Math.abs(num(shape.height, 0)) / 2
  if (!(a > 0 && b > 0)) return 0
  // The direction in the shape's own frame, as it was before it was turned.
  const angle = num(shape.angle, 0)
  const u = Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle))
  const v = Math.abs(dy * Math.cos(angle) - dx * Math.sin(angle))
  if (shape.type === 'ellipse') return 1 / Math.hypot(u / a, v / b)
  if (shape.type === 'diamond') return 1 / (u / a + v / b)
  return Math.min(a / u, b / v)
}

/**
 * An arrow sent with from and to, as the full element it stands for: straight
 * along the line between the two shapes' middles, from GAP outside one
 * outline to GAP outside the other, and bound to both, as Excalidraw draws an
 * arrow bound at both ends. Any x, y, width or height it was sent give way.
 */
function join(input: NewElement, { from, to }: Ends, live: Map<string, Element>): NewElement {
  const [start, end] = [from, to].map((shapeId, i) => {
    const shape = live.get(shapeId)
    const word = i === 0 ? 'from' : 'to'
    if (!shape) {
      throw new DrawError(
        `The arrow "${input.id}" goes ${word} "${shapeId}", which is not in the drawing. Nothing was saved. Add that shape first, or in the same call.`
      )
    }
    if (UNBINDABLE.has(shape.type)) {
      throw new DrawError(
        `The arrow "${input.id}" cannot go ${word} the ${shape.type} "${shapeId}": an arrow joins shapes and texts, not lines, arrows or freedraw. Nothing was saved.`
      )
    }
    if (shape.type === 'text' && typeof shape.containerId === 'string') {
      throw new DrawError(
        `The arrow "${input.id}" goes ${word} "${shapeId}", the label of "${shape.containerId}". Nothing was saved. Name the shape, "${shape.containerId}", instead.`
      )
    }
    return shape
  })
  const [[x1, y1], [x2, y2]] = [middle(start), middle(end)]
  const length = Math.hypot(x2 - x1, y2 - y1)
  const [dx, dy] = [(x2 - x1) / length, (y2 - y1) / length]
  const leave = reach(start, [dx, dy]) + GAP
  const arrive = length - reach(end, [-dx, -dy]) - GAP
  // Shapes that overlap, or sit closer than two gaps, leave no room for an arrow (and the same middle, no direction).
  if (!(arrive > leave)) {
    throw new DrawError(
      `The arrow "${input.id}" has no room between "${from}" and "${to}": they overlap or sit too close. Nothing was saved. ` +
        'Leave space between them, or give the arrow x, y and points.'
    )
  }
  const { width: _width, height: _height, ...rest } = input
  return {
    ...rest,
    x: round2(x1 + dx * leave),
    y: round2(y1 + dy * leave),
    points: [[0, 0], [round2(dx * (arrive - leave)), round2(dy * (arrive - leave))]],
    startBinding: { elementId: from },
    endBinding: { elementId: to },
  }
}

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

  const planned = plan(elements)
  if (planned.length > MAX_ADDED) {
    throw new DrawError(
      `These elements come to ${planned.length} with their labels, and draw adds at most ${MAX_ADDED} a call. Nothing was saved. Split them over more calls.`
    )
  }

  // Every id is new, a label's included. A deleted element keeps its id in the file.
  const used = new Set(existing.map((entry) => (isRecord(entry) ? entry.id : undefined)))
  const named = new Map<string, string | null>()
  for (const { input: { id }, labelOf } of planned) {
    if (used.has(id)) {
      throw new DrawError(
        labelOf === null
          ? `The drawing already has an element "${id}". Nothing was saved. Give each new element a new id; to change an element, use write_file.`
          : `The drawing already has an element "${id}", the id draw gives the label of "${labelOf}". Nothing was saved. Give "${labelOf}" another id.`
      )
    }
    if (named.has(id)) {
      const owner = labelOf ?? named.get(id)
      throw new DrawError(
        `The id "${id}" is used twice${owner ? `: draw gives it to the label of "${owner}"` : ''}. Nothing was saved. Give each new element its own id.`
      )
    }
    named.set(id, labelOf)
  }

  // Shapes first, and then each arrow between two shapes, placed from where
  // the shapes are, in the drawing or in this call.
  const indices = nextIndices(existing, planned.length)
  const made = planned.map(({ input, ends }, i) => (ends ? null : complete(input, indices[i], updated)))

  // A label and an arrow find their shapes among the live elements, in the
  // drawing or in this call, and each shape lists what is bound to it.
  const live = new Map<string, Element>()
  for (const entry of [...existing, ...made]) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.isDeleted !== true) live.set(entry.id, entry as Element)
  }
  planned.forEach(({ input, ends }, i) => {
    if (!ends) return
    const arrow = complete(join(input, ends, live), indices[i], updated)
    made[i] = arrow
    live.set(arrow.id, arrow)
  })
  const added = made as Element[]

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
  return { content: JSON.stringify(scene, null, 2), added: added.length, elementCount }
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
