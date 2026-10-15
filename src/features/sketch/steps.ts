/**
 * How a drawing's elements are sketched in, one after another, as a person
 * would draw them: each line drawn along its length (a path's pieces one
 * after another, as a pen goes), hachure fills scribbled in, solid fills
 * faded in after their outline, and text written left to right. The chat
 * card's live view draws a drawing as it is written this way
 * (src/chat-card/live/mount.ts), and the app's canvas sketches an agent's new
 * elements in the same way (src/features/drawings/sketchIn.ts), each with
 * the pencil sound (pencil.ts).
 *
 * Each element is a `<g>` of SVG: `stepsOf` reads how its parts come in,
 * `itemMs` how long it takes, and `playSteps` animates it.
 */

/**
 * One part of an element and how it comes in: drawn along its length (a
 * path's pieces one after another, as a pen goes), written left to right,
 * or faded in.
 */
export type Step = { how: "stroke" | "text" | "fade"; ms: number; pieces: Array<{ el: SVGGraphicsElement; length: number }> }

/** Pencil strokes start at most this often, so a quick finish is not a burst of sound. */
export const STROKE_GAP_MS = 70

/** The next element starts when this one is most of the way drawn (this much of its time). */
export const NEXT_AT = 0.7

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * How an element's parts come in, in order: its lines, then its hachure
 * (thinner lines than the outline), then its solid fills and the rest.
 * Dashed lines fade in: drawing them along would undo their dashes. What
 * only shapes others (a mask, a clip path, definitions) is not a part.
 */
export function stepsOf(g: SVGGElement): Step[] {
  const parts = [...g.querySelectorAll<SVGGraphicsElement>("path, text, rect")].filter((part) => !part.closest("mask, clipPath, defs, symbol"))
  const width = (part: Element) => Number(part.getAttribute("stroke-width")) || 0
  const lines = parts.filter((part) => part.tagName === "path" && part.getAttribute("fill") === "none" && part.getAttribute("stroke") !== "none" && !part.hasAttribute("stroke-dasharray"))
  const widest = Math.max(0, ...lines.map(width))
  const line = (part: SVGGraphicsElement): Step => {
    // A dash pattern starts again with each piece of a path (each side, each
    // hachure line), so each piece is drawn as a path of its own, in turn.
    const pieces = (part.getAttribute("d") ?? "").split(/(?=M)/).filter((piece) => piece.trim())
    const els =
      pieces.length > 1
        ? pieces.map((d) => {
            const piece = part.cloneNode() as SVGGraphicsElement
            piece.setAttribute("d", d)
            part.before(piece)
            return piece
          })
        : [part]
    if (els.length > 1) part.remove()
    const measured = els.map((el) => {
      try {
        return { el, length: (el as SVGPathElement).getTotalLength() }
      } catch {
        // Not measurable here: it fades in.
        return { el, length: 0 }
      }
    })
    const length = measured.reduce((total, piece) => total + piece.length, 0)
    return length > 0 ? { how: "stroke", ms: clamp(length / 1.6, 150, 600), pieces: measured } : { how: "fade", ms: 200, pieces: measured }
  }
  const outline = lines.filter((part) => width(part) >= widest).map(line)
  const hachure = lines.filter((part) => width(part) < widest).map(line)
  const rest = parts
    .filter((part) => !lines.includes(part))
    .map((part): Step => ({
      how: part.tagName === "text" ? "text" : "fade",
      ms: part.tagName === "text" ? clamp((part.textContent ?? "").length * 28, 150, 600) : 200,
      pieces: [{ el: part, length: 0 }],
    }))
  const texts = rest.filter((step) => step.how === "text")
  return [...outline, ...hachure, ...rest.filter((step) => step.how !== "text"), ...texts]
}

/** How long an element takes at normal speed: its steps one after another, lines overlapping a little. */
export const itemMs = (steps: Step[]) => steps.reduce((total, step) => total + step.ms * (step.how === "stroke" ? 0.85 : 1), 0)

/**
 * How long elements that each take `ms` at normal speed take one after
 * another: each starts when the one before is most of the way drawn
 * (NEXT_AT), and the last is drawn to its end.
 */
export const sketchMs = (items: ReadonlyArray<{ ms: number }>) => items.reduce((total, item) => total + item.ms * NEXT_AT, 0) + (items.at(-1)?.ms ?? 0) * 0.3

/**
 * Draws an element's steps in, `speed` times as fast as normal: each line
 * along its length at one pace, piece after piece, text from the left, the
 * rest faded in. `track` gets each animation, with what to do when it ends
 * (or is cancelled). Returns how long the element takes to draw, in ms.
 */
export function playSteps(steps: Step[], speed: number, track: (animation: Animation, done?: () => void) => void): number {
  let at = 0
  for (const step of steps) {
    const ms = step.ms / speed
    if (step.how === "stroke") {
      // The pen moves at one speed along the whole path, piece after piece.
      const total = step.pieces.reduce((sum, piece) => sum + piece.length, 0)
      let along = 0
      for (const { el, length } of step.pieces) {
        const dash = length + 1
        el.style.strokeDasharray = `${dash} ${dash}`
        const timing: KeyframeAnimationOptions = { duration: (ms * length) / total, delay: at + (ms * along) / total, fill: "backwards" }
        track(el.animate([{ strokeDashoffset: dash }, { strokeDashoffset: 0 }], timing), () => (el.style.strokeDasharray = ""))
        along += length
      }
    } else {
      const timing: KeyframeAnimationOptions = { duration: ms, delay: at, fill: "backwards" }
      for (const { el } of step.pieces) {
        track(step.how === "text" ? el.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], timing) : el.animate([{ opacity: 0 }, { opacity: 1 }], timing))
      }
    }
    at += step.how === "stroke" ? ms * 0.85 : ms
  }
  return at
}
