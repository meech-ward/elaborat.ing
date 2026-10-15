// Completing a drawing's elements: draw's completion, which draw, the writes
// that save a drawing (create_and_show, update_and_show, write_file, and the
// in-app assistant's write_file) and the chat card's live view all use, so
// each makes the same elements. Plain TypeScript with no imports, so Deno,
// Bun and the browser import it as it is.
//
// Two shortcuts, like Excalidraw's element skeletons
// (convertToExcalidrawElements), spare a model the arithmetic: a shape or
// arrow may take a label, added as a text bound to it, and an arrow may name
// the two shapes it joins (from, to) instead of its points. Each becomes the
// full elements a model could write, so both forms come out the same. Fields
// an element leaves out get the defaults Excalidraw 0.18.1 gives a new
// element, except that a seed and versionNonce, which Excalidraw picks at
// random, come from the element's id: the live view and the saved drawing
// draw the same strokes, and a retried save makes the same file.

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
/** What a label can sit in (Excalidraw's text containers). */
const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow'])
/** What an arrow cannot attach to. */
const UNBINDABLE = new Set(['arrow', 'line', 'freedraw'])

/** Excalidraw's line height for each font family (0.18.1); 1.25 for any other. */
const LINE_HEIGHT: Record<number, number> = { 1: 1.25, 2: 1.15, 3: 1.2, 5: 1.25, 6: 1.35, 7: 1.15, 8: 1.25, 9: 1.15 }

/** How far short of a shape's outline Excalidraw ends an arrow bound to it. */
const GAP = 8
/** A shape sized to its label is at least this big. */
const MIN_SIZE = { width: 140, height: 70 }
/**
 * A shape sized to its label is at most this wide: its label wraps at its
 * spaces to fit, and the shape grows taller instead, so shapes 300 apart
 * leave room for an arrow. Only a word longer than a line makes it wider.
 */
export const MAX_SIZED_WIDTH = 240
/** The room around a label in a shape sized to it: each side, and above and below. */
const LABEL_ROOM = { x: 20, y: 10 }
/** How much bigger than the box it holds a shape is: the largest box inside an ellipse is 1/√2 of it each way, inside a diamond half. */
const HOLDS: Record<string, number> = { rectangle: 1, ellipse: Math.SQRT2, diamond: 2 }

type Element = Record<string, unknown> & { id: string; type: string }
type Point = [number, number]

/**
 * Why the elements cannot be completed. Nothing is saved, and the message
 * goes back to the model. `element` is the element at fault, as it was
 * given, which the live view leaves out until it can be completed.
 */
export class DrawError extends Error {
  constructor(message: string, readonly element?: unknown) {
    super(message)
  }
}

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const round2 = (value: number) => Math.round(value * 100) / 100
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A whole number from 1 to 2^31 - 1 that `text` always gives (FNV-1a), for
 * a seed or nonce Excalidraw would pick at random.
 */
function numberOf(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) % 0x7fffffff) + 1
}
/** The seed an element without one gets: from its id, so it is drawn the same everywhere. */
export const seedOf = (id: string) => numberOf(`seed:${id}`)
/** The versionNonce an element without one gets, from its id. */
export const nonceOf = (id: string) => numberOf(`nonce:${id}`)

/**
 * Whether an element is in draw's short form: it has a label, or from or
 * to, fields no Excalidraw element has.
 */
export const isShortForm = (element: unknown): boolean =>
  isRecord(element) && (element.label !== undefined || element.from !== undefined || element.to !== undefined)

/** The box points cover, as Excalidraw sizes a line from its points. */
function pointsSize(points: Point[]): { width: number; height: number } {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** How wide one line of text is. Excalidraw measures text with its font; this is near enough until it does. */
const lineWidth = (line: string, fontSize: number) => [...line].length * fontSize * 0.55

/** The box text takes. */
function textBox(text: string, fontSize: number, lineHeight: number): { width: number; height: number } {
  const lines = text.split('\n')
  return {
    width: round2(Math.max(...lines.map((line) => lineWidth(line, fontSize)))),
    height: round2(lines.length * fontSize * lineHeight),
  }
}

/**
 * A label wrapped at its spaces into lines `width` wide, as Excalidraw wraps
 * a label to its shape: a line that fits stays as it was given, line breaks
 * included. A word longer than `width` makes every line as wide as it, so it
 * fits on a line of its own.
 */
function wrapLabel(label: string, width: number, fontSize: number): string {
  const longest = Math.max(...label.split(/\s+/).map((word) => lineWidth(word, fontSize)))
  const fits = (line: string) => lineWidth(line, fontSize) <= Math.max(width, longest)
  return label
    .split('\n')
    .flatMap((given) => {
      if (fits(given)) return [given]
      const lines: string[] = []
      let line = ''
      for (const [, space, word] of given.matchAll(/(\s*)(\S+)/g)) {
        if (line !== '' && !fits(line + space + word)) {
          lines.push(line)
          line = word
        } else line += space + word
      }
      return [...lines, line]
    })
    .join('\n')
}

/**
 * A shape's size for its label, and the label wrapped to fit it: to the
 * width the shape was given, or else to keep it at most MAX_SIZED_WIDTH
 * wide. The label's box with room around it, inside the largest box the
 * shape holds, and at least MIN_SIZE.
 */
function sizeFor(type: string, label: string, width?: number): { width: number; height: number; text: string } {
  const holds = HOLDS[type] ?? 1
  const text = wrapLabel(label, (width ?? MAX_SIZED_WIDTH) / holds - 2 * LABEL_ROOM.x, 20)
  const box = textBox(text, 20, LINE_HEIGHT[5])
  return {
    width: Math.max(MIN_SIZE.width, Math.ceil((box.width + 2 * LABEL_ROOM.x) * holds)),
    height: Math.max(MIN_SIZE.height, Math.ceil((box.height + 2 * LABEL_ROOM.y) * holds)),
    text,
  }
}

/** An arrow's two ends: the ids of the shapes it joins. */
type Ends = { from: string; to: string }

/**
 * What an element becomes. `kept`: a full element in a write, which stays as
 * it is. Otherwise one to complete: as it was given, less label, from and
 * to (`input`); the ends of an arrow drawn between two shapes; for a label
 * made from `label`, the shape or arrow it is for; and the element as given,
 * which an error names.
 */
type Planned =
  | { kept: true; element: unknown }
  | { kept: false; input: Element; ends: Ends | null; labelOf: string | null; given: unknown }

/** One new element with every field Excalidraw gives a new one, those it was given kept. Without `index` or `updated`, it has none. */
function complete({ input, given: source }: Extract<Planned, { kept: false }>, index: string | undefined, updated: number | undefined): Element {
  const { id, type } = input
  const given = input as Record<string, unknown>
  let specific: Record<string, unknown> = {}
  let size: { width: number; height: number } | null = null

  if (typeof input.x !== 'number' || typeof input.y !== 'number') {
    throw new DrawError(
      type === 'arrow'
        ? `The arrow "${id}" needs from and to, or x, y and points. Nothing was saved.`
        : `The ${type} "${id}" needs x and y. Nothing was saved.`,
      source
    )
  }
  if (SHAPES.has(type)) {
    if (!(num(input.width, 0) > 0 && num(input.height, 0) > 0)) {
      throw new DrawError(`The ${type} "${id}" needs a width and a height above 0, or a label to be sized to.`, source)
    }
  } else if (type === 'text') {
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') throw new DrawError(`The text "${id}" needs some text.`, source)
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
      throw new DrawError(`The ${type} "${id}" needs points, relative to its x and y, such as [[0, 0], [120, 0]].`, source)
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
      if (type === 'arrow' && isRecord(attached)) specific[end] = { focus: 0, gap: 8, ...attached }
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
    ...(index !== undefined ? { index } : {}),
    // Rounded corners on a rectangle, as Excalidraw gives a new one; `roundness: null` keeps them square.
    roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: seedOf(id),
    version: 1,
    versionNonce: nonceOf(id),
    isDeleted: false,
    boundElements: [],
    ...(updated !== undefined ? { updated } : {}),
    link: null,
    locked: false,
    ...specific,
    ...given,
  }
  // Each in turn after the scene's last element, whatever index it was given.
  if (index !== undefined) completed.index = index
  for (const end of ['startBinding', 'endBinding'] as const) {
    if (specific[end]) completed[end] = specific[end]
  }
  return completed
}

/**
 * What one element to complete becomes: itself, less label, from and to,
 * and right after a shape or arrow with a label, the text bound to it,
 * `<id>-label`. A labelled shape with no width or height is sized to its
 * label. Throws a DrawError for a label or an end that it cannot take.
 */
function plan(element: unknown): Planned[] {
  if (!isRecord(element) || typeof element.id !== 'string' || element.id === '' || typeof element.type !== 'string') {
    throw new DrawError('Each element needs an id and a type, such as {"id": "api", "type": "rectangle"}. Nothing was saved.', element)
  }
  const { label, from, to, ...input } = element as Element
  const { id, type } = input
  let ends: Ends | null = null
  if (from !== undefined || to !== undefined) {
    if (type !== 'arrow') throw new DrawError(`The ${type} "${id}" has from or to, which only an arrow takes. Nothing was saved.`, element)
    if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
      throw new DrawError(`The arrow "${id}" needs both from and to: the ids of the two shapes it joins. Nothing was saved.`, element)
    }
    if (input.points !== undefined || input.startBinding || input.endBinding) {
      throw new DrawError(
        `The arrow "${id}" has from and to, and points or a binding as well. Nothing was saved. ` +
          'Give from and to without points, startBinding and endBinding, and draw works them out; or give those without from and to.',
        element
      )
    }
    if (from === to) throw new DrawError(`The arrow "${id}" goes from "${from}" to itself. Nothing was saved. Give from and to two different shapes.`, element)
    ends = { from, to }
  }
  // The lines a label shows: wrapped to fit a shape sized to it, else as it was given.
  let text = label
  if (label !== undefined) {
    if (!CONTAINERS.has(type)) {
      throw new DrawError(
        `The ${type} "${id}" has a label, which only a rectangle, ellipse, diamond or arrow can hold. Nothing was saved.` +
          (type === 'text' ? ' Put the words in its text.' : ''),
        element
      )
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw new DrawError(`The label of the ${type} "${id}" is empty. Nothing was saved. Give it some text, or leave label out.`, element)
    }
    if (SHAPES.has(type) && (input.width === undefined || input.height === undefined)) {
      const size = sizeFor(type, label, typeof input.width === 'number' ? input.width : undefined)
      input.width ??= size.width
      input.height ??= size.height
      text = size.text
    }
  }
  const planned: Planned[] = [{ kept: false, input, ends, labelOf: null, given: element }]
  if (label !== undefined) {
    // As Excalidraw keeps a label: its lines in text, and in originalText the label as given, which it wraps again when the shape is resized.
    planned.push({
      kept: false,
      input: { id: `${id}-label`, type: 'text', x: 0, y: 0, text, originalText: label, containerId: id },
      ends: null,
      labelOf: id,
      given: element,
    })
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
 * An arrow given from and to, as the full element it stands for: straight
 * along the line between the two shapes' middles, from GAP outside one
 * outline to GAP outside the other, and bound to both, as Excalidraw draws an
 * arrow bound at both ends. Any x, y, width or height it was given give way.
 */
function join({ input, given }: Extract<Planned, { kept: false }>, { from, to }: Ends, live: Map<string, Element>): Element {
  const [start, end] = [from, to].map((shapeId, i) => {
    const shape = live.get(shapeId)
    const word = i === 0 ? 'from' : 'to'
    if (!shape) {
      throw new DrawError(
        `The arrow "${input.id}" goes ${word} "${shapeId}", which is not in the drawing. Nothing was saved. Add that shape first, or in the same call.`,
        given
      )
    }
    if (UNBINDABLE.has(shape.type)) {
      throw new DrawError(
        `The arrow "${input.id}" cannot go ${word} the ${shape.type} "${shapeId}": an arrow joins shapes and texts, not lines, arrows or freedraw. Nothing was saved.`,
        given
      )
    }
    if (shape.type === 'text' && typeof shape.containerId === 'string') {
      throw new DrawError(
        `The arrow "${input.id}" goes ${word} "${shapeId}", the label of "${shape.containerId}". Nothing was saved. Name the shape, "${shape.containerId}", instead.`,
        given
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
        'Leave space between them, or give the arrow x, y and points.',
      given
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
 * middle segment). The x and y it was given don't matter, so a model never
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

export type CompleteOptions = {
  /** Excalidraw's `updated` (when it last changed) for each element completed; without it they have none. */
  updated?: number
  /** The order indices for the elements completed, given how many there are; without it they have none, and Excalidraw gives them theirs when it opens the drawing. */
  indices?: (count: number) => string[]
  /**
   * Complete only the elements in the short form, and keep each full one as
   * it is (a write); otherwise each one is completed (draw). A short-form
   * label replaces the label text its shape or arrow had.
   */
  shortFormOnly?: boolean
}

/**
 * The completion. `scene`: the elements a drawing has already (draw's),
 * kept as they are. `elements`: those to complete, in order. Returns the
 * scene's elements, then `elements` completed, each label right after its
 * shape or arrow, and how many elements were completed, labels included.
 * Elements completed find the shapes their labels and arrows go on in the
 * scene or among `elements`, and each shape lists in its boundElements what
 * was newly bound to it, as Excalidraw keeps them; nothing else already
 * there changes.
 *
 * Throws a DrawError, which names the element at fault, for an id already
 * used, a label or an arrow whose shape is not there, or an element missing
 * what it needs.
 */
export function completeElements(
  scene: readonly unknown[],
  elements: readonly unknown[],
  { updated, indices, shortFormOnly = false }: CompleteOptions = {}
): { elements: unknown[]; added: number } {
  const planned = elements.flatMap((element): Planned[] => (shortFormOnly && !isShortForm(element) ? [{ kept: true, element }] : plan(element)))
  // A label in the short form replaces the label text its shape or arrow had.
  const relabelled = new Set(planned.flatMap((entry) => (!entry.kept && entry.labelOf !== null ? [entry.labelOf] : [])))
  const list = planned.filter(
    (entry) => !(entry.kept && isRecord(entry.element) && entry.element.type === 'text' && typeof entry.element.containerId === 'string' && relabelled.has(entry.element.containerId))
  )
  const count = list.filter((entry) => !entry.kept).length
  const order = indices?.(count)

  // Every id completed is new, a label's included: not in the scene (where a
  // deleted element keeps its id), and not used twice among the elements.
  const used = new Set(scene.map((entry) => (isRecord(entry) ? entry.id : undefined)))
  const named = new Map<string, Planned>()
  for (const entry of list) {
    const id = entry.kept ? (isRecord(entry.element) ? entry.element.id : undefined) : entry.input.id
    if (typeof id !== 'string') continue
    const labelOf = entry.kept ? null : entry.labelOf
    const at = entry.kept ? entry.element : entry.given
    if (!entry.kept && used.has(id)) {
      throw new DrawError(
        labelOf === null
          ? `The drawing already has an element "${id}". Nothing was saved. Give each new element a new id; to change an element, use write_file.`
          : `The drawing already has an element "${id}", the id draw gives the label of "${labelOf}". Nothing was saved. Give "${labelOf}" another id.`,
        at
      )
    }
    const other = named.get(id)
    if (other && !(other.kept && entry.kept)) {
      const owner = labelOf ?? (other.kept ? null : other.labelOf)
      throw new DrawError(`The id "${id}" is used twice${owner ? `: draw gives it to the label of "${owner}"` : ''}. Nothing was saved. Give each new element its own id.`, at)
    }
    if (!other) named.set(id, entry)
  }

  // Shapes first, and then each arrow between two shapes, placed from where
  // the shapes are, in the scene or among the elements.
  let next = 0
  const indexAt = list.map((entry) => (entry.kept ? undefined : order?.[next++]))
  const made = new Set<unknown>()
  const out = list.map((entry, i): unknown => {
    if (entry.kept) return entry.element
    if (entry.ends) return null
    const element = complete(entry, indexAt[i], updated)
    made.add(element)
    return element
  })

  // A label and an arrow find their shapes among the live elements, in the
  // scene or among the elements, and each shape lists what is bound to it.
  const live = new Map<string, Element>()
  for (const entry of [...scene, ...out]) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.isDeleted !== true) live.set(entry.id, entry as Element)
  }
  list.forEach((entry, i) => {
    if (entry.kept || !entry.ends) return
    const arrow = complete({ ...entry, input: join(entry, entry.ends, live) }, indexAt[i], updated)
    out[i] = arrow
    made.add(arrow)
    live.set(arrow.id, arrow)
  })
  const madeIds = new Set([...made].map((element) => (element as Element).id))

  const bound = new Map<string, { type: 'text' | 'arrow'; id: string }[]>()
  const bind = (from: Element, targetId: string, kind: 'text' | 'arrow', at: unknown) => {
    const target = live.get(targetId)
    const what = kind === 'text' ? `The label "${from.id}"` : `The arrow "${from.id}"`
    if (!target) {
      throw new DrawError(`${what} is bound to "${targetId}", which is not in the drawing. Nothing was saved. Add that shape first, or in the same call.`, at)
    }
    if (kind === 'text' ? !CONTAINERS.has(target.type) : UNBINDABLE.has(target.type)) {
      const may = kind === 'text' ? 'a rectangle, ellipse, diamond or arrow' : 'a shape or a text, not a line, arrow or freedraw'
      throw new DrawError(`${what} cannot be bound to the ${target.type} "${targetId}": it can be bound to ${may}. Nothing was saved.`, at)
    }
    bound.set(targetId, [...(bound.get(targetId) ?? []), { type: kind, id: from.id }])
  }
  // The bindings an element completed makes, and in a write those of a full
  // element to one completed, which it now lists.
  list.forEach((entry, i) => {
    const element = out[i]
    if (!isRecord(element) || typeof element.id !== 'string' || (entry.kept && element.isDeleted === true)) return
    const mine = made.has(element)
    const at = entry.kept ? entry.element : entry.given
    if (element.type === 'text' && typeof element.containerId === 'string' && (mine || madeIds.has(element.containerId))) {
      bind(element as Element, element.containerId, 'text', at)
      if (mine) placeLabel(element as Element, live.get(element.containerId)!)
    }
    if (element.type !== 'arrow') return
    for (const end of [element.startBinding, element.endBinding]) {
      if (isRecord(end) && typeof end.elementId === 'string' && (mine || madeIds.has(end.elementId))) bind(element as Element, end.elementId, 'arrow', at)
    }
  })
  /** The element with what was bound to it listed, or the very same element when it lists all of it already. */
  const listing = <T>(entry: T): T => {
    if (!isRecord(entry) || entry.isDeleted === true || typeof entry.id !== 'string') return entry
    const listed: unknown[] = Array.isArray(entry.boundElements) ? entry.boundElements : []
    const missing = (bound.get(entry.id) ?? []).filter(({ id }, i, all) =>
      !listed.some((item) => isRecord(item) && item.id === id) && all.findIndex((other) => other.id === id) === i
    )
    return missing.length === 0 ? entry : ({ ...entry, boundElements: [...listed, ...missing] } as T)
  }

  return { elements: [...scene.map(listing), ...out.map(listing)], added: count }
}

/**
 * A drawing's text as a write saves it: with its elements in the short form
 * completed, the full ones kept as they are, as 2-space JSON; or, when it
 * has no element in the short form (or is not JSON), byte for byte as given.
 * The same text always gives the same file, so a retried save is the same
 * save. Throws a DrawError, saving nothing, for an element that cannot be
 * completed.
 */
export function completeDrawing(content: string): string {
  let scene: unknown
  try {
    scene = JSON.parse(content)
  } catch {
    return content
  }
  if (!isRecord(scene) || !Array.isArray(scene.elements) || !scene.elements.some(isShortForm)) return content
  const { elements } = completeElements([], scene.elements, { shortFormOnly: true })
  return JSON.stringify({ ...scene, elements }, null, 2)
}

/**
 * A file's content as a write saves it: a `.excalidraw` drawing completed
 * (completeDrawing), anything else, an Obsidian `.excalidraw.md` included,
 * as it is.
 */
export const completeFile = (path: string, content: string): string => (/\.excalidraw$/i.test(path) ? completeDrawing(content) : content)
