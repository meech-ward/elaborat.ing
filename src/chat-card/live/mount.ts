/**
 * The chat card's live view: a new note, drawing or diagram shown while the
 * agent is still writing it (create_and_show's partial input), until the
 * saved card takes its place. It draws with the server's own renderers, the
 * same ones that make the saved card (drawElement, renderNote), so nothing
 * changes when the card settles. Built into the card's `live` module
 * (../lazy/live.ts), which loads only when a card goes live.
 *
 * A drawing's elements draw in one after another as a person would sketch
 * them: each line drawn along its length, hachure fills scribbled in, solid
 * fills faded in after their outline, text written left to right, and the
 * view easing out to hold what is drawn so far. A note renders as Markdown,
 * its new blocks fading in and the last one written into with a caret. A
 * diagram's D2 source writes in as text. With reduced motion, everything
 * just appears.
 */
import { drawElement, MAX_ELEMENTS, MAX_SVG_CHARS, type Box } from "../../../supabase/functions/mcp-server/tools/drawingSvg.ts"
import { renderNote } from "../../../supabase/functions/mcp-server/tools/markdown.ts"
import { drawingScanner, noteTail, type SceneElement } from "./partial"
import { readingMarkup } from "../readingMarkup"

export type LiveKind = "note" | "drawing" | "diagram"
export type LiveOptions = { kind: LiveKind; path: string; reducedMotion: boolean }
export type LiveHandle = {
  /** The file so far; `final`: all of it (the tool's input), which then draws in within a short time. */
  update(content: string, final?: boolean): void
  /** Draws what is left quickly; resolves when it is drawn. */
  finish(): Promise<void>
  destroy(): void
}

/** Characters of a note the card renders, as the server's preview. */
const PREVIEW_LIMIT = 40_000
/** How long the rest of a drawing takes once its whole input is in, and once the file is saved. */
const FINAL_MS = 1200
const SETTLE_MS = 400
/** A note renders at most this often. */
const NOTE_MS = 100
/** The smallest part of the scene the view shows, so the first shapes are not blown up. */
const MIN_VIEW: [number, number] = [400, 240]
const PADDING = 10

const SVG_NS = "http://www.w3.org/2000/svg"

const STYLE = `
.live-svg{display:block;width:100%!important;height:100%!important;max-width:none!important}
.live-in{animation:live-in .28s ease-out both}
@keyframes live-in{from{opacity:0;transform:translateY(4px)}}
.live-caret{display:inline-block;width:2px;height:1.05em;margin-left:1px;vertical-align:-.15em;background:var(--accent)}
.live-blink{animation:live-blink 1.05s steps(1) infinite}
@keyframes live-blink{50%{opacity:0}}
.live-embed{display:flex;align-items:center;justify-content:center;min-height:96px;padding:12px;border:1px dashed var(--panel-border);border-radius:.75rem;color:var(--muted);font:12.5px/1.4 var(--code-font);overflow-wrap:anywhere;text-align:center}
.live-more{position:absolute;inset-inline:0;bottom:8px;margin:0;color:var(--muted);font-size:13px;text-align:center}
.live-source{margin:0;padding:20px 24px;color:var(--text);font:13px/1.65 var(--code-font);white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:500px){.live-source{padding:16px}}
`

function addStyle() {
  if (document.querySelector("style[data-live]")) return
  const style = document.createElement("style")
  style.dataset.live = ""
  style.textContent = STYLE
  document.head.append(style)
}

function moreNote(el: HTMLElement, text: string) {
  const note = document.createElement("p")
  note.className = "live-more"
  note.textContent = text
  note.hidden = true
  el.append(note)
  return note
}

export function mountLive(el: HTMLElement, options: LiveOptions): LiveHandle {
  addStyle()
  if (options.kind === "drawing") return mountDrawing(el, options.reducedMotion)
  return mountText(el, options)
}

/**
 * One part of an element and how it comes in: drawn along its length (a
 * path's pieces one after another, as a pen goes), written left to right,
 * or faded in.
 */
type Step = { how: "stroke" | "text" | "fade"; ms: number; pieces: Array<{ el: SVGGraphicsElement; length: number }> }
type Item = { g: SVGGElement; box: Box; steps: Step[]; ms: number }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * How an element's parts come in, in order: its lines, then its hachure
 * (thinner lines than the outline), then its solid fills and the rest.
 * Dashed lines fade in: drawing them along would undo their dashes.
 */
function stepsOf(g: SVGGElement): Step[] {
  const parts = [...g.querySelectorAll<SVGGraphicsElement>("path, text, rect")]
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
const itemMs = (steps: Step[]) => steps.reduce((total, step) => total + step.ms * (step.how === "stroke" ? 0.85 : 1), 0)

function mountDrawing(el: HTMLElement, reducedMotion: boolean): LiveHandle {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("class", "live-svg")
  svg.setAttribute("aria-hidden", "true")
  el.append(svg)
  const more = moreNote(el, "Still drawing")

  const scanner = drawingScanner()
  const types = new Map<unknown, unknown>()
  let drawnCount = 0
  let size = 0
  let full = false
  const bounds: Box = [Infinity, Infinity, -Infinity, -Infinity]
  let view: number[] | null = null
  let target: number[] | null = null
  const queue: Item[] = []
  const running = new Set<Animation>()
  let nextAt = 0
  let deadline: number | null = null
  let frame = 0
  let last = 0
  let settled: (() => void) | null = null

  const grow = (box: Box) => {
    bounds[0] = Math.min(bounds[0], box[0])
    bounds[1] = Math.min(bounds[1], box[1])
    bounds[2] = Math.max(bounds[2], box[2])
    bounds[3] = Math.max(bounds[3], box[3])
    const width = Math.max(bounds[2] - bounds[0] + PADDING * 2, MIN_VIEW[0])
    const height = Math.max(bounds[3] - bounds[1] + PADDING * 2, MIN_VIEW[1])
    target = [(bounds[0] + bounds[2] - width) / 2, (bounds[1] + bounds[3] - height) / 2, width, height]
  }

  const showView = (next: number[]) => {
    view = next
    svg.setAttribute("viewBox", next.map((value) => Math.round(value * 10) / 10).join(" "))
  }

  const add = (element: SceneElement) => {
    if (full) return
    types.set(element.id, element.type)
    const drawn = drawElement(element, types)
    if (!drawn) return
    drawnCount++
    size += drawn.part.length
    if (drawnCount > MAX_ELEMENTS || size > MAX_SVG_CHARS) {
      full = true
      more.hidden = false
      return
    }
    svg.insertAdjacentHTML("beforeend", drawn.part)
    const g = svg.lastElementChild as SVGGElement
    if (reducedMotion) return grow(drawn.box)
    g.style.opacity = "0"
    const steps = stepsOf(g)
    queue.push({ g, box: drawn.box, steps, ms: itemMs(steps) })
  }

  const clear = () => {
    for (const animation of running) animation.cancel()
    running.clear()
    queue.length = 0
    svg.replaceChildren()
    types.clear()
    drawnCount = size = 0
    full = false
    more.hidden = true
    bounds.splice(0, 4, Infinity, Infinity, -Infinity, -Infinity)
    view = target = null
  }

  /** How fast the next element draws: faster as a backlog grows, and fast enough to end by the deadline. */
  const speedAt = (now: number) => {
    let speed = 1 + Math.max(0, queue.length - 2) * 0.35
    if (deadline !== null) {
      const work = queue.reduce((total, item) => total + item.ms * 0.7, 0) + (queue.at(-1)?.ms ?? 0) * 0.3
      speed = Math.max(speed, work / Math.max(50, deadline - now))
    }
    return speed
  }

  const play = (item: Item, speed: number): number => {
    item.g.style.opacity = ""
    let at = 0
    const track = (animation: Animation, done?: () => void) => {
      running.add(animation)
      animation.onfinish = animation.oncancel = () => {
        running.delete(animation)
        done?.()
      }
    }
    for (const step of item.steps) {
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

  const tick = (now: number) => {
    frame = 0
    while (queue.length > 0 && now >= nextAt) {
      const speed = speedAt(now)
      const item = queue.shift()!
      const ms = play(item, speed)
      grow(item.box)
      // The next element starts when this one is most of the way drawn.
      nextAt = Math.max(nextAt, now - 32) + ms * 0.7
    }
    let moving = false
    if (target) {
      if (!view) showView(target)
      else {
        const k = 1 - Math.pow(0.86, Math.min(4, (now - last) / 16.7))
        const next = view.map((value, index) => value + (target![index] - value) * k)
        moving = next.some((value, index) => Math.abs(value - target![index]) > 0.5)
        showView(moving ? next : target)
      }
    }
    last = now
    if (queue.length > 0 || running.size > 0 || moving) frame = requestAnimationFrame(tick)
    else if (settled) {
      settled()
      settled = null
    }
  }

  const kick = () => {
    if (!frame) {
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }

  return {
    update(content, final = false) {
      const { added, restarted } = scanner.read(content)
      if (restarted) clear()
      for (const element of added) add(element)
      if (reducedMotion) {
        if (target) showView(target)
        return
      }
      if (final) deadline = Math.min(deadline ?? Infinity, performance.now() + FINAL_MS)
      if (added.length > 0 || restarted) kick()
    },
    finish() {
      if (reducedMotion || (queue.length === 0 && running.size === 0)) {
        if (target) showView(target)
        return Promise.resolve()
      }
      const now = performance.now()
      deadline = Math.min(deadline ?? Infinity, now + SETTLE_MS)
      for (const animation of running) {
        const timing = animation.effect?.getComputedTiming()
        const left = (Number(timing?.endTime ?? 0) - Number(timing?.localTime ?? 0)) / (animation.playbackRate || 1)
        if (left > SETTLE_MS - 50) animation.updatePlaybackRate((animation.playbackRate || 1) * (left / (SETTLE_MS - 50)))
      }
      kick()
      return new Promise((resolve) => {
        settled = resolve
        // A frame the host does not paint (out of sight) never ticks: settle anyway.
        setTimeout(resolve, SETTLE_MS + 200)
      })
    },
    destroy() {
      cancelAnimationFrame(frame)
      for (const animation of running) animation.cancel()
      settled?.()
      svg.remove()
      more.remove()
    },
  }
}

const VOID = new Set(["BR", "HR", "IMG", "INPUT"])

/** A node's last child that is not just whitespace. */
function lastNode(node: Element): ChildNode | null {
  let child = node.lastChild
  while (child && child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) child = child.previousSibling
  return child
}

/**
 * A note or a diagram's source as it is written, in a `[data-live-viewport]`
 * that follows the writing: a note in its `[data-live-content]`, a diagram's
 * source in a block of code type of its own. A note renders
 * with the server's renderNote, at most ten times a second: blocks that did
 * not change stay, new ones fade in, and the last one is written into with a
 * caret.
 */
function mountText(el: HTMLElement, { kind, reducedMotion }: LiveOptions): LiveHandle {
  const viewport = el.querySelector<HTMLElement>("[data-live-viewport]") ?? el
  const given = el.querySelector<HTMLElement>("[data-live-content]")
  const content = given ?? viewport.appendChild(document.createElement("pre"))
  if (!given) content.className = "live-source"
  const more = moreNote(el, "Still writing")
  const caret = document.createElement("span")
  caret.className = reducedMotion ? "live-caret" : "live-caret live-blink"
  caret.setAttribute("aria-hidden", "true")
  const shown: string[] = []
  let latest = ""
  let rendered = ""
  let timer = 0
  let lastRender = 0

  const follow = () => viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? "instant" : "smooth" })

  const render = () => {
    timer = 0
    lastRender = performance.now()
    if (latest === rendered) return
    rendered = latest
    let text = latest
    const cut = text.length > PREVIEW_LIMIT
    if (cut) {
      const end = text.lastIndexOf("\n", PREVIEW_LIMIT)
      text = text.slice(0, end > 0 ? end : PREVIEW_LIMIT)
    }
    more.hidden = !cut
    if (kind === "diagram") {
      content.textContent = text
      if (!cut) content.append(caret)
      return follow()
    }
    let note: ReturnType<typeof renderNote>
    try {
      note = renderNote(noteTail(text))
    } catch {
      return
    }
    const holder = document.createElement("div")
    holder.innerHTML = note.html
    // A drawing or diagram the note embeds shows as a box until the saved card draws it.
    for (const figure of holder.querySelectorAll<HTMLElement>("figure[data-embed]")) {
      const embed = note.embeds[Number(figure.dataset.embed)]
      const box = document.createElement("div")
      box.className = "live-embed"
      box.textContent = embed ? `${embed.kind === "diagram" ? "Diagram" : "Drawing"} ${embed.path}` : ""
      figure.replaceWith(box)
    }
    // Task items, code blocks and tables in the app's markup, as the saved card shows them.
    readingMarkup(holder)
    caret.remove()
    const blocks = [...holder.children]
    const current = [...content.children]
    blocks.forEach((block, index) => {
      const html = block.outerHTML
      if (shown[index] === html) return
      shown[index] = html
      const old = current[index]
      if (old) old.replaceWith(block)
      else {
        content.append(block)
        if (!reducedMotion) block.classList.add("live-in")
      }
    })
    for (const old of current.slice(blocks.length)) old.remove()
    shown.length = blocks.length
    // The caret goes where the writing is: the end of the last block's last words.
    let spot = content.lastElementChild
    for (let next = spot && lastNode(spot); next instanceof Element && !VOID.has(next.tagName); next = lastNode(next)) spot = next
    if (!cut && spot && !spot.classList.contains("live-embed") && !VOID.has(spot.tagName)) spot.append(caret)
    follow()
  }

  return {
    update(text, final = false) {
      latest = text
      if (final) {
        clearTimeout(timer)
        return render()
      }
      if (!timer) timer = window.setTimeout(render, Math.max(0, lastRender + NOTE_MS - performance.now()))
    },
    finish() {
      clearTimeout(timer)
      render()
      return Promise.resolve()
    },
    destroy() {
      clearTimeout(timer)
      if (given) given.replaceChildren()
      else content.remove()
      more.remove()
    },
  }
}
