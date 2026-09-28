import { useDeferredValue, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from "react"
import { commentsShortcut, isApplePlatform } from "@/features/design-system"
import { canvasPins, canvasPlaces, nextPinThread, type CanvasElement, type CanvasPin } from "./canvasPins"
import { useCommentsUi, useFileThreads, useProjectComments } from "./context"
import type { CommentFile } from "./controller"
import { DRAFT_MARK } from "./noteMarks"
import { elementLabel, type ElementAnchor } from "./placement"
import type { RemoteThread } from "./remote"

/** What a drawing's canvas needs for comments (DrawingCanvas's `comments`). */
export type CanvasCommentsProps = {
  pins: readonly CanvasPin[]
  canComment: boolean
  shortcut: { label: string; aria: string }
  onOpen: (pin: CanvasPin) => void
  onComment: (target: { elementId: string; point?: { x: number; y: number } }) => void
}

const NO_PINS: readonly CanvasPin[] = []

/**
 * A drawing's or a diagram's comments on its elements, for the view that
 * shows it. While the file is the panel's (the page says so, see
 * WorkspaceWorkbench), its element threads are placed on the scene on screen
 * (unsaved edits included): pins for the live ones, detached for the rest.
 * Element comments hang on the drawing itself, or on a D2 diagram's
 * generated canvas. `onReveal` runs when the panel asks to show a thread's
 * element. Null where the file can have no comments.
 */
export function useCanvasComments({
  path,
  elements,
  onReveal,
}: {
  path: string
  /** The scene's elements as the canvas shows them, or null before there is a scene. */
  elements: readonly CanvasElement[] | null
  onReveal: (elementId: string) => void
}): CanvasCommentsProps | null {
  const comments = useProjectComments()
  const controller = comments?.controller ?? null
  const ui = useCommentsUi()
  const target = ui.target?.path === path ? ui.target : null
  // A drawing's element comments are on the drawing; a diagram's on its canvas file.
  const file: CommentFile | null = target ? (target.elements === undefined ? target.file : target.elements) : null
  const { threads } = useFileThreads(file?.fileId ?? null)
  // Placing every thread runs as the scene changes; a deferred copy keeps drawing quick.
  const scene = useDeferredValue(elements)
  const places = useMemo(() => canvasPlaces(threads, scene ?? []), [threads, scene])
  useEffect(() => {
    if (controller && file) controller.place(file.fileId, places)
  }, [controller, file, places])

  const request = ui.request && file && ui.request.file.fileId === file.fileId && ui.request.anchor.kind === "element" ? ui.request : null
  const pins = useMemo(
    () =>
      threads.length === 0 && !request
        ? NO_PINS
        : canvasPins(threads, places, ui.activeThreadId, request ? { anchor: request.anchor, label: request.text ?? (request.anchor as ElementAnchor).label } : null),
    [places, request, threads, ui.activeThreadId],
  )

  // The panel's Go to: show the thread's element, when it is still there.
  const latest = useRef<readonly RemoteThread[]>(threads)
  useLayoutEffect(() => {
    latest.current = threads
  }, [threads])
  const reveal = useEffectEvent(onReveal)
  const shown = target !== null
  useEffect(() => {
    if (!controller || !shown) return
    return controller.onReveal((threadId) => {
      const anchor = latest.current.find((thread) => thread.id === threadId)?.anchor
      if (anchor?.kind === "element") reveal(anchor.element_id)
    })
  }, [controller, shown])

  if (!comments || !target) return null
  const canComment = Boolean(comments.canWrite && file)
  return {
    pins: file ? pins : NO_PINS,
    canComment,
    shortcut: commentsShortcut(isApplePlatform()),
    onOpen(pin) {
      if (pin.id === DRAFT_MARK) comments.controller.setPanelOpen(true)
      else {
        const threadId = nextPinThread(pin, ui.activeThreadId)
        if (threadId) comments.controller.openThread(threadId, true)
      }
    },
    onComment({ elementId, point }) {
      if (!file || !comments.canWrite || !elements) return
      const label = elementLabel(elements, elementId)
      if (label === null) return
      const anchor: ElementAnchor = { kind: "element", element_id: elementId, label, ...(point ? { point } : {}) }
      comments.controller.requestComment({ file, anchor, text: label })
    },
  }
}
