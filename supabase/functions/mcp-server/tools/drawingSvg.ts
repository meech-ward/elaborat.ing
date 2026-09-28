import rough from 'npm:roughjs@4.6.6'
import type { RoughGenerator } from 'npm:roughjs@4.6.6/bin/generator.js'

// Reading the scene is shared with search's indexing.
export { parseDrawing } from '../../_shared/drawing.ts'

// Draws a saved Excalidraw scene as SVG on the server, for the file view.
// The view runs in the host's sandbox with no network, so it gets finished
// SVG markup, not a renderer. Shapes go through roughjs, the library
// Excalidraw draws with, with the element's own seed and options, so they
// keep their hand-drawn look. Text names Excalifont, which the view carries
// for Latin text, then the reader's system fonts. Images and frames are not
// drawn: an image shows as a dashed box, a frame's contents are drawn without
// its outline. In a diagram, a shape the generator left without a fill (as
// the app saves it, src/features/structured/emitter.ts) is filled as the app
// shows it: the fill carries a class, `d2-fill` (`d2-fill2` inside a
// container), that the view paints in its palette's diagram colour.
// The options mirror Excalidraw 0.18's renderer (element/src/shape.ts).

type Element = Record<string, unknown>
type Point = [number, number]

// The package's CommonJS entry is the rough object itself; its types describe it as a default export.
const generator = (rough as unknown as { generator(): RoughGenerator }).generator()
type Drawable = ReturnType<typeof generator.rectangle>
type Options = NonNullable<Parameters<typeof generator.rectangle>[4]>
type OpSet = Drawable['sets'][number]

/** Elements drawn at most; a bigger scene is not drawn. */
export const MAX_ELEMENTS = 3000
/** Characters of SVG markup at most; a bigger drawing is not shown. */
export const MAX_SVG_CHARS = 200_000

const INK = '#1e1e1e'
const PADDING = 10

/** A shape the D2 generator made (src/features/structured/generated.ts). */
const GENERATED = /^d2:/
/** Shapes the app fills (src/features/structured/presentation.ts). */
const FILLED = new Set(['rectangle', 'ellipse', 'diamond'])
/** The default palette's diagram fills, until the view paints its own. */
const DIAGRAM_FILL = { 'd2-fill': '#dcf5e8', 'd2-fill2': '#edf0ee' } as const
type FillClass = keyof typeof DIAGRAM_FILL

/** The class for a generated diagram shape's fill, or null when it keeps its own. */
function diagramFill(element: Element): FillClass | null {
  if (!FILLED.has(String(element.type)) || !GENERATED.test(String(element.id ?? ''))) return null
  if (element.backgroundColor !== 'transparent') return null
  return element.frameId ? 'd2-fill2' : 'd2-fill'
}

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;')

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|rgba|hsl|hsla)\([\d\s.,%/-]{1,60}\))$/i

/** A colour safe to write into an attribute, or null for none. */
function color(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'transparent' || !COLOR.test(trimmed)) return null
  return trimmed
}

/** The element's ink: its stroke colour, none when transparent, else Excalidraw's default. */
function ink(element: Element): string {
  const value = element.strokeColor
  if (typeof value === 'string' && value.trim().toLowerCase() === 'transparent') return 'none'
  return color(value) ?? INK
}

function points(element: Element): Point[] {
  const raw = Array.isArray(element.points) ? element.points : []
  return raw
    .filter((point): point is unknown[] => Array.isArray(point) && point.length >= 2)
    .map((point) => [num(point[0]), num(point[1])] as Point)
}

function cornerRadius(size: number, element: Element): number {
  const roundness = element.roundness as { type?: number; value?: number } | null
  if (roundness?.type === 3) {
    const fixed = num(roundness.value, 32)
    return size <= fixed / 0.25 ? size * 0.25 : fixed
  }
  return size * 0.25
}

function adjustRoughness(element: Element, width: number, height: number, linear: boolean): number {
  const roughness = num(element.roughness, 1)
  const max = Math.max(width, height)
  const min = Math.min(width, height)
  if ((min >= 20 && max >= 50) || (min >= 15 && !!element.roundness && !linear) || (linear && max >= 50)) return roughness
  return Math.min(roughness / (max < 10 ? 3 : 2), 2.5)
}

const FILL_STYLES = new Set(['hachure', 'cross-hatch', 'solid', 'zigzag', 'dots', 'dashed', 'zigzag-line'])

function roughOptions(element: Element, width: number, height: number, linear: boolean, fillClass: FillClass | null = null): Options {
  const strokeWidth = num(element.strokeWidth, 2)
  const style = element.strokeStyle
  const solid = style !== 'dashed' && style !== 'dotted'
  const roughness = adjustRoughness(element, width, height, linear)
  return {
    seed: Math.max(1, Math.floor(num(element.seed, 1))),
    strokeLineDash: style === 'dashed' ? [8, 8 + strokeWidth] : style === 'dotted' ? [1.5, 6 + strokeWidth] : undefined,
    disableMultiStroke: !solid,
    strokeWidth: solid ? strokeWidth : strokeWidth + 0.5,
    fillWeight: strokeWidth / 2,
    hachureGap: strokeWidth * 4,
    roughness,
    stroke: ink(element),
    preserveVertices: roughness < 2,
    fill: fillClass ? DIAGRAM_FILL[fillClass] : (color(element.backgroundColor) ?? undefined),
    fillStyle: FILL_STYLES.has(String(element.fillStyle)) ? String(element.fillStyle) : 'hachure',
  }
}

function drawableSvg(drawable: Drawable, fillClass: FillClass | null = null): string {
  const options = drawable.options
  const marked = fillClass ? ` class="${fillClass}"` : ''
  return drawable.sets
    .map((set: OpSet) => {
      const d = generator.opsToPath(set, 1)
      if (set.type === 'path') {
        const dash = options.strokeLineDash ? ` stroke-dasharray="${options.strokeLineDash.join(' ')}"` : ''
        return `<path d="${d}" stroke="${escapeAttr(options.stroke)}" stroke-width="${fmt(options.strokeWidth)}" fill="none"${dash}/>`
      }
      if (set.type === 'fillPath') {
        const rule = drawable.shape === 'curve' || drawable.shape === 'polygon' ? ' fill-rule="evenodd"' : ''
        return `<path d="${d}" stroke="none" fill="${escapeAttr(options.fill ?? 'none')}"${rule}${marked}/>`
      }
      const weight = options.fillWeight < 0 ? options.strokeWidth / 2 : options.fillWeight
      return `<path d="${d}" stroke="${escapeAttr(options.fill ?? 'none')}" stroke-width="${fmt(weight)}" fill="none"${fillClass ? ` class="${fillClass}-sketch"` : ''}/>`
    })
    .join('')
}

/** Excalidraw's elbow arrow: straight segments with rounded corners. */
function elbowPath(pts: Point[], radius: number): string {
  const horizontal = (a: Point, b: Point) => Math.abs(a[0] - b[0]) >= Math.abs(a[1] - b[1])
  const step = (point: Point, toward: Point, corner: number): Point =>
    horizontal(point, toward)
      ? [point[0] + (toward[0] < point[0] ? -corner : corner), point[1]]
      : [point[0], point[1] + (toward[1] < point[1] ? -corner : corner)]
  const d = [`M ${pts[0][0]} ${pts[0][1]}`]
  for (let i = 1; i < pts.length - 1; i++) {
    const [prev, point, next] = [pts[i - 1], pts[i], pts[i + 1]]
    const corner = Math.min(radius, Math.hypot(next[0] - point[0], next[1] - point[1]) / 2, Math.hypot(prev[0] - point[0], prev[1] - point[1]) / 2)
    const before = step(point, prev, corner)
    const after = step(point, next, corner)
    d.push(`L ${before[0]} ${before[1]}`, `Q ${point[0]} ${point[1]}, ${after[0]} ${after[1]}`)
  }
  const last = pts[pts.length - 1]
  d.push(`L ${last[0]} ${last[1]}`)
  return d.join(' ')
}

const rotate = ([x, y]: Point, [cx, cy]: Point, angle: number): Point => [
  (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle) + cx,
  (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle) + cy,
]

/** The arrowhead's tip and the point it points from, as Excalidraw finds them on the drawn curve. */
function arrowAxis(body: Drawable, pts: Point[], position: 'start' | 'end'): [Point, Point] {
  const ops = body.sets.find((set: OpSet) => set.type === 'path')?.ops ?? []
  const index = position === 'start' ? 1 : ops.length - 1
  const op = ops[index]
  const prev = ops[index - 1]
  if (op?.op === 'bcurveTo' && op.data.length === 6 && prev) {
    const p3: Point = [op.data[4], op.data[5]]
    const p2: Point = [op.data[2], op.data[3]]
    const p1: Point = [op.data[0], op.data[1]]
    const p0: Point = prev.op === 'bcurveTo' ? [prev.data[4], prev.data[5]] : [prev.data[0], prev.data[1]]
    const at = (t: number, i: 0 | 1) =>
      (1 - t) ** 3 * p3[i] + 3 * t * (1 - t) ** 2 * p2[i] + 3 * t ** 2 * (1 - t) * p1[i] + p0[i] * t ** 3
    return [position === 'start' ? p0 : p3, [at(0.3, 0), at(0.3, 1)]]
  }
  return position === 'start' ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]]
}

function arrowhead(element: Element, body: Drawable, pts: Point[], position: 'start' | 'end', base: Options): Drawable[] {
  const kind = element[position === 'start' ? 'startArrowhead' : 'endArrowhead']
  if (typeof kind !== 'string' || pts.length < 2) return []
  const [[x2, y2], [x1, y1]] = arrowAxis(body, pts, position)
  const distance = Math.hypot(x2 - x1, y2 - y1)
  if (distance === 0) return []
  const [nx, ny] = [(x2 - x1) / distance, (y2 - y1) / distance]
  const size = kind === 'arrow' ? 25 : kind.startsWith('diamond') ? 12 : 15
  const [tip, from] = position === 'end' ? [pts[pts.length - 1], pts[pts.length - 2]] : [pts[0], pts[1]]
  const segment = Math.hypot(tip[0] - from[0], tip[1] - from[1])
  const length = Math.min(size, segment * (kind.startsWith('diamond') ? 0.25 : 0.5))
  const back: Point = [x2 - nx * length, y2 - ny * length]
  const stroke = ink(element)
  const options: Options = { ...base, strokeLineDash: undefined, roughness: Math.min(1, base.roughness ?? 0) }
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
    const diameter = length + num(element.strokeWidth, 2) - 2
    const fill = kind === 'circle_outline' ? undefined : stroke
    return [generator.circle(x2, y2, diameter, { ...options, fill, fillStyle: 'solid', roughness: Math.min(0.5, base.roughness ?? 0) })]
  }
  const angle = ((kind === 'bar' ? 90 : kind === 'arrow' ? 20 : 25) * Math.PI) / 180
  const left = rotate(back, [x2, y2], -angle)
  const right = rotate(back, [x2, y2], angle)
  const fill = kind.endsWith('_outline') ? undefined : stroke
  if (kind.startsWith('triangle')) {
    return [generator.polygon([[x2, y2], left, right, [x2, y2]], { ...options, fill, fillStyle: 'solid' })]
  }
  if (kind.startsWith('diamond')) {
    const far = rotate([x2 - length * 2, y2], [x2, y2], Math.atan2(ny, nx))
    return [generator.polygon([[x2, y2], left, far, right, [x2, y2]], { ...options, fill, fillStyle: 'solid' })]
  }
  return [generator.line(left[0], left[1], x2, y2, options), generator.line(right[0], right[1], x2, y2, options)]
}

const HAND = "Excalifont, Virgil, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

function fontFamily(value: unknown): string {
  if (value === 3 || value === 8) return MONO
  if (value === 1 || value === 5) return HAND
  return SANS
}

function textSvg(element: Element, width: number, height: number, onArrow: boolean): string {
  // An arrow's label hides the arrow behind it, as in Excalidraw. The view
  // paints this box in its own panel colour.
  const cutout = onArrow
    ? `<rect class="label-bg" x="-3" y="-3" width="${fmt(width + 6)}" height="${fmt(height + 6)}" rx="4" fill="#ffffff"/>`
    : ''
  const fontSize = num(element.fontSize, 20)
  const lineHeight = fontSize * num(element.lineHeight, 1.25)
  const align = element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start'
  const x = align === 'middle' ? width / 2 : align === 'end' ? width : 0
  const fill = escapeAttr(ink(element))
  return cutout + String(element.text ?? '')
    .split('\n')
    .map(
      (line, i) =>
        `<text x="${fmt(x)}" y="${fmt(i * lineHeight + lineHeight / 2)}" font-family="${fontFamily(element.fontFamily)}" ` +
        `font-size="${fmt(fontSize)}" fill="${fill}" text-anchor="${align}" dominant-baseline="central" style="white-space:pre">${escapeText(line)}</text>`
    )
    .join('')
}

/** One element's SVG in its own coordinates, and its box there. */
function elementSvg(element: Element, types: Map<unknown, unknown>, diagram: boolean): { body: string; box: [number, number, number, number] } | null {
  const width = Math.abs(num(element.width))
  const height = Math.abs(num(element.height))
  const box: [number, number, number, number] = [0, 0, width, height]
  const fillClass = diagram ? diagramFill(element) : null
  switch (element.type) {
    case 'rectangle':
    case 'embeddable':
    case 'iframe': {
      const options = roughOptions(element, width, height, false, fillClass)
      if (!element.roundness) return { body: drawableSvg(generator.rectangle(0, 0, width, height, options), fillClass), box }
      const r = cornerRadius(Math.min(width, height), element)
      const d = `M ${r} 0 L ${width - r} 0 Q ${width} 0, ${width} ${r} L ${width} ${height - r} Q ${width} ${height}, ${width - r} ${height} L ${r} ${height} Q 0 ${height}, 0 ${height - r} L 0 ${r} Q 0 0, ${r} 0`
      return { body: drawableSvg(generator.path(d, options), fillClass), box }
    }
    case 'diamond': {
      const options = roughOptions(element, width, height, false, fillClass)
      const [tx, ty, rx, ry, bx, by, lx, ly] = [Math.floor(width / 2) + 1, 0, width, Math.floor(height / 2) + 1, Math.floor(width / 2) + 1, height, 0, Math.floor(height / 2) + 1]
      if (!element.roundness) return { body: drawableSvg(generator.polygon([[tx, ty], [rx, ry], [bx, by], [lx, ly]], options), fillClass), box }
      const v = cornerRadius(Math.abs(tx - lx), element)
      const h = cornerRadius(Math.abs(ry - ty), element)
      const d = `M ${tx + v} ${ty + h} L ${rx - v} ${ry - h} C ${rx} ${ry}, ${rx} ${ry}, ${rx - v} ${ry + h} L ${bx + v} ${by - h} C ${bx} ${by}, ${bx} ${by}, ${bx - v} ${by - h} L ${lx + v} ${ly + h} C ${lx} ${ly}, ${lx} ${ly}, ${lx + v} ${ly - h} L ${tx - v} ${ty + h} C ${tx} ${ty}, ${tx} ${ty}, ${tx + v} ${ty + h}`
      return { body: drawableSvg(generator.path(d, options), fillClass), box }
    }
    case 'ellipse': {
      const options = { ...roughOptions(element, width, height, false, fillClass), curveFitting: 1 }
      return { body: drawableSvg(generator.ellipse(width / 2, height / 2, width, height, options), fillClass), box }
    }
    case 'line':
    case 'arrow': {
      const pts = points(element)
      if (pts.length < 2) return null
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const lineBox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      const options = roughOptions(element, lineBox[2] - lineBox[0], lineBox[3] - lineBox[1], true)
      const first = pts[0]
      const last = pts[pts.length - 1]
      const loop = element.type === 'line' && pts.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 8
      if (!loop) options.fill = undefined
      let body: Drawable
      if (element.type === 'arrow' && element.elbowed === true) body = generator.path(elbowPath(pts, 16), { ...options, fill: undefined })
      else if (element.roundness) body = generator.curve(pts, options)
      else body = loop && options.fill ? generator.polygon(pts, options) : generator.linearPath(pts, options)
      const heads = element.type === 'arrow' ? [...arrowhead(element, body, pts, 'start', options), ...arrowhead(element, body, pts, 'end', options)] : []
      return { body: [body, ...heads].map((drawable) => drawableSvg(drawable)).join(''), box: lineBox }
    }
    case 'freedraw': {
      const pts = points(element)
      if (pts.length === 0) return null
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const d = pts.length === 1
        ? `M ${fmt(pts[0][0])} ${fmt(pts[0][1])} l 0.01 0`
        : 'M ' + pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' L ')
      const stroke = escapeAttr(ink(element))
      const body = `<path d="${d}" stroke="${stroke}" stroke-width="${fmt(num(element.strokeWidth, 2) * 3)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
      return { body, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
    }
    case 'text':
      return { body: textSvg(element, width, height, types.get(element.containerId) === 'arrow'), box }
    case 'image':
      return { body: `<rect width="${fmt(width)}" height="${fmt(height)}" rx="8" stroke="#868e96" stroke-width="1.5" stroke-dasharray="6 6" fill="none"/>`, box }
    default:
      return null
  }
}

export type DrawingSvg = { svg: string } | { problem: 'empty' | 'too_big' }

/**
 * The scene as one SVG on a transparent background, or why it is not drawn.
 * A diagram's canvas (`diagram`) gets its generated shapes filled.
 */
export function drawingSvg(elements: Element[], maxChars = MAX_SVG_CHARS, { diagram = false }: { diagram?: boolean } = {}): DrawingSvg {
  if (elements.length > MAX_ELEMENTS) return { problem: 'too_big' }
  const types = new Map(elements.map((element) => [element.id, element.type]))
  const parts: string[] = []
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  let size = 0
  for (const element of elements) {
    const drawn = elementSvg(element, types, diagram)
    if (!drawn) continue
    const x = num(element.x)
    const y = num(element.y)
    const angle = num(element.angle)
    const [bx1, by1, bx2, by2] = drawn.box
    const center: Point = [(bx1 + bx2) / 2, (by1 + by2) / 2]
    for (const corner of [[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]] as Point[]) {
      const [cx, cy] = rotate(corner, center, angle)
      minX = Math.min(minX, x + cx)
      minY = Math.min(minY, y + cy)
      maxX = Math.max(maxX, x + cx)
      maxY = Math.max(maxY, y + cy)
    }
    const turn = angle ? ` rotate(${fmt((angle * 180) / Math.PI)} ${fmt(center[0])} ${fmt(center[1])})` : ''
    const opacity = num(element.opacity, 100)
    const fade = opacity < 100 ? ` opacity="${fmt(Math.max(0, opacity) / 100)}"` : ''
    const part = `<g transform="translate(${fmt(x)} ${fmt(y)})${turn}"${fade}>${drawn.body}</g>`
    size += part.length
    if (size > maxChars) return { problem: 'too_big' }
    parts.push(part)
  }
  if (parts.length === 0) return { problem: 'empty' }
  const [vx, vy] = [minX - PADDING, minY - PADDING]
  const [vw, vh] = [maxX - minX + PADDING * 2, maxY - minY + PADDING * 2]
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vx)} ${fmt(vy)} ${fmt(vw)} ${fmt(vh)}" ` +
      `width="${fmt(vw)}" height="${fmt(vh)}">${parts.join('')}</svg>`,
  }
}
