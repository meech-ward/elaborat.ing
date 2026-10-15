/**
 * The chat card's live view: a note, drawing or diagram shown while the
 * agent is still writing it (create_and_show's and update_and_show's partial
 * input), until the saved card takes its place. It draws with the server's
 * own renderers, the same ones that make the saved card (drawElement,
 * renderNote), so nothing changes when the card settles. Built into the
 * card's `live` module (../lazy/live.ts), which loads only when a card goes
 * live.
 *
 * A drawing's elements draw in one after another as a person would sketch
 * them, completed as the server saves them (an element in draw's short form
 * sized, labelled and placed, an arrow once both its shapes have come), each
 * with a quiet pencil sound (src/features/sketch, which the app's
 * canvas shares): each line drawn along its length, hachure fills scribbled
 * in, solid fills faded in after their outline, text written left to right,
 * and the view easing out to hold what is drawn so far. A note renders as
 * Markdown, its new blocks fading in and the last one written into with a
 * caret. A diagram's D2 source writes in as text. With reduced motion,
 * everything just appears, in silence.
 *
 * A change to a saved file (update_and_show) starts from the file as saved
 * (`base`): a drawing's elements show at once, those the new content keeps
 * stay, changed and new ones draw in as they come, and those it leaves out
 * fade once the whole input is in; a note shows as saved while the new text
 * is the same as its start, and from where it differs the new text writes in.
 */
import { drawElement, MAX_ELEMENTS, MAX_SVG_CHARS, parseDrawing, type Box } from "../../../supabase/functions/mcp-server/tools/drawingSvg.ts"
import { renderNote } from "../../../supabase/functions/mcp-server/tools/markdown.ts"
import { pencil } from "@/features/sketch/pencil"
import { itemMs, NEXT_AT, playSteps, sketchMs, stepsOf, STROKE_GAP_MS, type Step } from "@/features/sketch/steps"
import { drawingScanner, elementChange, noteBeingChanged, noteTail, shortFormReader, type SceneElement } from "./partial"
import { readingMarkup } from "../readingMarkup"

export type LiveKind = "note" | "drawing" | "diagram"
/** `sound`: the pencil sound starts on (the person's setting); it is never on with reduced motion. */
export type LiveOptions = { kind: LiveKind; path: string; reducedMotion: boolean; sound?: boolean }
export type LiveHandle = {
  /** The file so far; `final`: all of it (the tool's input), which then draws in within a short time. */
  update(content: string, final?: boolean): void
  /** The file as saved before this change (update_and_show), once read: what stays shows at once. */
  base(content: string): void
  /** Draws what is left quickly; resolves when it is drawn. */
  finish(): Promise<void>
  /** Turns the pencil sound on or off. */
  setSound(on: boolean): void
  destroy(): void
}

/** Characters of a note the card renders, as the server's preview (fileView.ts). */
const PREVIEW_LIMIT = 20_000
/** How long the rest of a drawing takes once its whole input is in, and once the file is saved. */
const FINAL_MS = 1200
const SETTLE_MS = 400
/** How long a saved element the new drawing leaves out takes to fade, and one it changes once its new one starts. */
const LEAVE_MS = 320
const REPLACE_MS = 200
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
  if (options.kind === "drawing") return mountDrawing(el, options.path, options.reducedMotion, options.sound ?? true)
  return mountText(el, options)
}

/** An element waiting to draw in: its parts, what kind it is (for its sound), and the saved one it changes, if any. */
type Item = { g: SVGGElement; box: Box; steps: Step[]; ms: number; type: string; replaces: SVGGElement | null }

function mountDrawing(el: HTMLElement, path: string, reducedMotion: boolean, sound: boolean): LiveHandle {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("class", "live-svg")
  svg.setAttribute("aria-hidden", "true")
  el.append(svg)
  const more = moreNote(el, "Still drawing")
  const pen = reducedMotion ? null : pencil(sound)
  let lastStroke = -Infinity

  // A change to a saved drawing: the saved file, its elements by id, the
  // <g> of each one still shown as saved, the ids the new content has had,
  // and whether the ones it left out have gone. `whole`: all the input is in.
  let whole = false
  let savedFile: string | null = null
  let saved = new Map<unknown, SceneElement>()
  const shownSaved = new Map<unknown, SVGGElement>()
  const seen = new Set<unknown>()
  let retired = false

  const scanner = drawingScanner()
  // A .excalidraw file is saved with its short form completed; an Obsidian .excalidraw.md as it is.
  const shortForm = /\.excalidraw$/i.test(path) ? shortFormReader() : null
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

  /** Fades a saved element out and takes it away; with reduced motion, at once. */
  const leave = (g: SVGGElement, ms: number) => {
    if (reducedMotion) return g.remove()
    const animation = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: "forwards" })
    running.add(animation)
    animation.onfinish = animation.oncancel = () => {
      running.delete(animation)
      g.remove()
    }
    kick()
  }

  /** Whether one more drawn part fits; when it does not, the view says it is still drawing and takes no more. */
  const fits = (part: string) => {
    drawnCount++
    size += part.length
    if (drawnCount <= MAX_ELEMENTS && size <= MAX_SVG_CHARS) return true
    full = true
    more.hidden = false
    return false
  }

  const add = (element: SceneElement) => {
    if (full) return
    seen.add(element.id)
    types.set(element.id, element.type)
    // Against the saved drawing, if this is a change: an element it keeps shows already.
    const change = elementChange(saved, element)
    if (change === "kept") return
    const old = change === "changed" ? (shownSaved.get(element.id) ?? null) : null
    shownSaved.delete(element.id)
    const drawn = drawElement(element, types)
    if (!drawn || !fits(drawn.part)) {
      if (old) leave(old, REPLACE_MS)
      return
    }
    svg.insertAdjacentHTML("beforeend", drawn.part)
    const g = svg.lastElementChild as SVGGElement
    if (reducedMotion) {
      old?.remove()
      return grow(drawn.box)
    }
    g.style.opacity = "0"
    const steps = stepsOf(g)
    queue.push({ g, box: drawn.box, steps, ms: itemMs(steps), type: String(element.type), replaces: old })
  }

  /**
   * The saved drawing at once, under what the new content has drawn so
   * far: every element the new content has not had yet.
   */
  const showSaved = () => {
    if (savedFile === null) return
    let elements: SceneElement[]
    try {
      elements = parseDrawing(savedFile)
    } catch {
      return
    }
    saved = new Map(elements.filter((element) => typeof element.id === "string").map((element) => [element.id, element]))
    for (const element of elements) if (!types.has(element.id)) types.set(element.id, element.type)
    const parts: string[] = []
    const ids: unknown[] = []
    for (const element of elements) {
      if (full) break
      if (seen.has(element.id)) continue
      const drawn = drawElement(element, types)
      if (!drawn || !fits(drawn.part)) continue
      parts.push(drawn.part)
      ids.push(element.id)
      grow(drawn.box)
    }
    svg.insertAdjacentHTML("afterbegin", parts.join(""))
    const placed = [...svg.children].slice(0, ids.length) as SVGGElement[]
    ids.forEach((id, index) => shownSaved.set(id, placed[index]))
    if (reducedMotion || !view) {
      if (target) showView(target)
    } else kick()
  }

  /** The saved elements the new content left out fade, once all of it is in. */
  const retire = () => {
    if (retired || savedFile === null) return
    retired = true
    for (const [id, g] of shownSaved) {
      if (seen.has(id)) continue
      shownSaved.delete(id)
      leave(g, LEAVE_MS)
    }
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
    saved = new Map()
    shownSaved.clear()
    seen.clear()
    retired = false
  }

  /** How fast the next element draws: faster as a backlog grows, and fast enough to end by the deadline. */
  const speedAt = (now: number) => {
    let speed = 1 + Math.max(0, queue.length - 2) * 0.35
    if (deadline !== null) {
      speed = Math.max(speed, sketchMs(queue) / Math.max(50, deadline - now))
    }
    return speed
  }

  const track = (animation: Animation, done?: () => void) => {
    running.add(animation)
    animation.onfinish = animation.oncancel = () => {
      running.delete(animation)
      done?.()
    }
  }

  const play = (item: Item, speed: number): number => {
    item.g.style.opacity = ""
    // The saved element this one changes goes as the new one starts.
    if (item.replaces) leave(item.replaces, REPLACE_MS)
    return playSteps(item.steps, speed, track)
  }

  const tick = (now: number) => {
    frame = 0
    while (queue.length > 0 && now >= nextAt) {
      const speed = speedAt(now)
      const item = queue.shift()!
      const ms = play(item, speed)
      if (pen && now - lastStroke >= STROKE_GAP_MS) {
        lastStroke = now
        pen.stroke(item.type, ms)
      }
      grow(item.box)
      // The next element starts when this one is most of the way drawn.
      nextAt = Math.max(nextAt, now - 32) + ms * NEXT_AT
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
      if (restarted) {
        clear()
        shortForm?.reset()
        showSaved()
      }
      if (added.length > 0) for (const element of shortForm ? shortForm.read(scanner.elements) : added) add(element)
      if (final) {
        whole = true
        retire()
      }
      if (reducedMotion) {
        if (target) showView(target)
        return
      }
      if (final) deadline = Math.min(deadline ?? Infinity, performance.now() + FINAL_MS)
      if (added.length > 0 || restarted) kick()
    },
    base(content) {
      // Read after all the input came: nothing is left to show at once.
      if (savedFile !== null || whole) return
      savedFile = content
      showSaved()
    },
    finish() {
      whole = true
      retire()
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
    setSound(on) {
      pen?.set(on)
    },
    destroy() {
      cancelAnimationFrame(frame)
      for (const animation of running) animation.cancel()
      settled?.()
      pen?.close()
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
 * caret. A change to a saved note shows the saved note at once while the new
 * text is still its start (noteBeingChanged), with no caret, and is written
 * into from where they differ.
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
  // The note as saved, for a change to it; and whether the whole input is in.
  let saved: string | null = null
  let whole = false
  let rendered: string | null = null
  let timer = 0
  let lastRender = 0

  const follow = () => viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? "instant" : "smooth" })

  const render = () => {
    timer = 0
    lastRender = performance.now()
    const now = kind === "note" && saved !== null ? noteBeingChanged(saved, latest, whole) : { text: latest, writing: true }
    const key = `${now.writing ? "w" : "s"}${now.text}`
    if (key === rendered) return
    rendered = key
    let text = now.text
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
      // The saved note is whole; only text being written may end in an open tag.
      note = renderNote(now.writing ? noteTail(text) : text)
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
        // What is being written fades in; a saved note shows at once.
        if (!reducedMotion && now.writing) block.classList.add("live-in")
      }
    })
    for (const old of current.slice(blocks.length)) old.remove()
    shown.length = blocks.length
    if (!now.writing) return
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
        whole = true
        clearTimeout(timer)
        return render()
      }
      if (!timer) timer = window.setTimeout(render, Math.max(0, lastRender + NOTE_MS - performance.now()))
    },
    base(text) {
      if (kind !== "note" || saved !== null) return
      saved = text
      clearTimeout(timer)
      render()
    },
    finish() {
      whole = true
      clearTimeout(timer)
      render()
      return Promise.resolve()
    },
    setSound() {},
    destroy() {
      clearTimeout(timer)
      if (given) given.replaceChildren()
      else content.remove()
      more.remove()
    },
  }
}
