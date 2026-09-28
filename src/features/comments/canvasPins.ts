import type { ThreadPlace } from "./controller"
import { DRAFT_MARK } from "./noteMarks"
import { elementLabel, type CommentAnchor, type LabelElement } from "./placement"
import type { RemoteThread } from "./remote"

// Where a drawing's threads are on its canvas, and the pins it shows: one
// for each spot with open threads on a live element, and one for a new
// comment while it is being written. Pure: the canvas and the panel share it.

/** A comment pin on a drawing: the threads it opens and the spot it marks on its element. */
export type CanvasPin = {
  /** The element and spot, or DRAFT_MARK for a new comment. */
  id: string
  elementId: string
  /** The spot, as fractions of the element's unrotated box; without it the pin sits at the element's top-right corner. */
  point?: { x: number; y: number }
  /** The threads it opens, in the order a click moves through them. Empty for a new comment. */
  threadIds: readonly string[]
  /** What it opens, for screen readers: "2 threads on Sign up". */
  label: string
  /** It holds the thread open in the panel, or it is the new comment. */
  active: boolean
}

/** A drawing element as the pins read it: its id, and what its label is made from. */
export type CanvasElement = LabelElement & { id?: unknown }

/**
 * Where each of a drawing's threads is on the canvas now, by thread id: an
 * element thread is attached while its element is live, and its text is the
 * element's label now. The whole file is always attached. Text anchors never
 * attach to a drawing.
 */
export function canvasPlaces(threads: readonly RemoteThread[], elements: readonly CanvasElement[]): Map<string, ThreadPlace> {
  const wanted = new Set<string>()
  for (const thread of threads) if (thread.anchor.kind === "element") wanted.add(thread.anchor.element_id)
  const live = new Map<string, CanvasElement>()
  const bound = new Map<string, CanvasElement>()
  if (wanted.size > 0) {
    for (const element of elements) {
      if (element.isDeleted === true) continue
      if (typeof element.id === "string" && wanted.has(element.id)) live.set(element.id, element)
      if (element.type === "text" && typeof element.containerId === "string" && wanted.has(element.containerId)) bound.set(element.containerId, element)
    }
  }
  const places = new Map<string, ThreadPlace>()
  for (const thread of threads) {
    const { anchor } = thread
    if (anchor.kind === "document") places.set(thread.id, { attached: true })
    else if (anchor.kind !== "element") places.set(thread.id, { attached: false })
    else {
      const element = live.get(anchor.element_id)
      if (!element) places.set(thread.id, { attached: false })
      else {
        // The label as it is now: the element's own text, or its bound text's.
        const text = elementLabel([element, ...(bound.has(anchor.element_id) ? [bound.get(anchor.element_id)!] : [])], anchor.element_id)
        places.set(thread.id, { attached: true, ...(text !== null ? { text } : {}) })
      }
    }
  }
  return places
}

const pointKey = (point?: { x: number; y: number }) => (point ? `${point.x},${point.y}` : "corner")

/**
 * The pins for a drawing: open threads on live elements, one pin per
 * element and spot (threads at the same spot share it), then the new
 * comment's if it is on an element. Ordered as the threads were made.
 */
export function canvasPins(
  threads: readonly RemoteThread[],
  places: ReadonlyMap<string, ThreadPlace>,
  activeThreadId: string | null,
  draft: { anchor: CommentAnchor; label: string } | null,
): CanvasPin[] {
  const pins = new Map<string, { elementId: string; point?: { x: number; y: number }; threadIds: string[]; label: string }>()
  for (const thread of threads) {
    const { anchor } = thread
    const place = places.get(thread.id)
    if (thread.resolved_at !== null || anchor.kind !== "element" || !place?.attached) continue
    const key = `${anchor.element_id}\n${pointKey(anchor.point)}`
    const pin = pins.get(key)
    if (pin) pin.threadIds.push(thread.id)
    else pins.set(key, { elementId: anchor.element_id, ...(anchor.point ? { point: anchor.point } : {}), threadIds: [thread.id], label: place.text ?? anchor.label })
  }
  const result: CanvasPin[] = [...pins].map(([key, pin]) => ({
    id: key,
    ...pin,
    label: `${pin.threadIds.length} ${pin.threadIds.length === 1 ? "thread" : "threads"} on ${pin.label}`,
    active: activeThreadId !== null && pin.threadIds.includes(activeThreadId),
  }))
  if (draft?.anchor.kind === "element") {
    const { element_id, point } = draft.anchor
    result.push({ id: DRAFT_MARK, elementId: element_id, ...(point ? { point } : {}), threadIds: [], label: `New comment on ${draft.label}`, active: true })
  }
  return result
}

/** The thread a pin opens next: the one after the open thread, or its first. */
export function nextPinThread(pin: CanvasPin, activeThreadId: string | null): string | null {
  if (pin.threadIds.length === 0) return null
  const current = activeThreadId === null ? -1 : pin.threadIds.indexOf(activeThreadId)
  return pin.threadIds[(current + 1) % pin.threadIds.length]
}
