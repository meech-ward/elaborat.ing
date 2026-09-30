import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { CommentsButton, FloatingPanel, LoadingLine, commentsShortcut, isApplePlatform } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { cn } from "@/lib/utils"
import { useCommentsUi, useFileThreads, useProjectComments, type ProjectCommentsValue } from "../context"
import type { CommentsUiState, ThreadPlace } from "../controller"
import { fileNoun, threadViews } from "./threadViews"

// The comments of the file on screen as the library draws them: the panel
// beside the file on a desktop, the sheet from the bottom on a phone, and
// the button that shows and hides them. They read the project's comments
// (context.tsx): the store for the threads, the controller for the file on
// screen, the open thread and a new comment.

const NO_PLACES: ReadonlyMap<string, ThreadPlace> = new Map()
const noSubscription = () => () => {}

/**
 * Someone without an account, in the local project: the button and the
 * panel show, and say comments need an account. `signUp` is the link.
 */
type Guest = { open: boolean; onOpenChange: (open: boolean) => void; signUp: ReactNode }
export const GuestContext = createContext<Guest | null>(null)

export function CommentsGuestProvider({ value, children }: { value: Guest | null; children: ReactNode }) {
  return <GuestContext value={value}>{children}</GuestContext>
}

/** The toggle, for giving focus back when the panel closes. */
export const TOGGLE = "[data-comments-toggle]"
/** The panel or sheet. */
export const SURFACE = "[data-comments-surface]"

/** Runs `then` once React has shown what changed. */
export function afterRender(then: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(then))
}

export function focusThread(threadId: string) {
  afterRender(() => {
    const thread = document.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`)
    thread?.scrollIntoView({ block: "nearest" })
    thread?.focus({ preventScroll: true })
  })
}

/**
 * The file on screen's threads, placed, live. A D2 diagram's include the
 * ones on its generated canvas's elements (`elementsId`).
 */
export function useFileComments(comments: ProjectCommentsValue | null, ui: CommentsUiState) {
  const file = ui.target?.file ?? null
  const fileId = file?.fileId ?? null
  const elementsFileId = ui.target?.elements?.fileId ?? null
  const elementsId = elementsFileId !== fileId ? elementsFileId : null
  const own = useFileThreads(fileId)
  const onElements = useFileThreads(elementsId)
  const threads = useMemo(
    () =>
      onElements.threads.length === 0
        ? own.threads
        : [...own.threads, ...onElements.threads].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    [own.threads, onElements.threads],
  )
  const statuses = [own.status, onElements.status]
  // Loading until both lists are in, so the second is not read out as new comments.
  const status =
    statuses.includes("error") ? "error" : statuses.includes("loading") || (elementsId !== null && onElements.status === "idle") ? "loading" : own.status
  const controller = comments?.controller
  const subscribe = controller?.subscribe ?? noSubscription
  const ownPlaces = useSyncExternalStore(subscribe, () => (controller && fileId ? controller.placesFor(fileId) : NO_PLACES))
  const elementPlaces = useSyncExternalStore(subscribe, () => (controller && elementsId ? controller.placesFor(elementsId) : NO_PLACES))
  const places = useMemo(() => (elementPlaces.size === 0 ? ownPlaces : new Map([...ownPlaces, ...elementPlaces])), [ownPlaces, elementPlaces])
  const userId = comments?.userId ?? null
  const owner = comments?.owner ?? false
  const noun = ui.target ? fileNoun(ui.target.path) : "note"
  const views = useMemo(() => threadViews(threads, places, { userId, owner }, noun), [threads, places, userId, owner, noun])
  return { file, fileId, elementsId, threads, status, views, noun }
}

/**
 * Shows and hides the comments: the header's button with the open count on
 * a desktop, the round one over the file on a phone.
 */
export function CommentsToggle({ size = "default" }: { size?: "default" | "touch" }) {
  const comments = useProjectComments()
  const guest = useContext(GuestContext)
  const ui = useCommentsUi()
  const { views } = useFileComments(comments, ui)
  if (!comments && !guest) return null
  const open = guest ? guest.open : ui.panelOpen
  return (
    <CommentsButton
      data-comments-toggle=""
      size={size}
      count={views.open.length}
      pressed={open}
      shortcut={size === "default" ? commentsShortcut(isApplePlatform()) : undefined}
      onClick={() => (guest ? guest.onOpenChange(!open) : comments?.controller.setPanelOpen(!open))}
    />
  )
}

// The panel and sheet, with the threads, the composer and the shortcut, load
// in their own chunk once the project has shown, off its first paint.
const surfaceView = moduleLoader(() => import("./CommentsSurfaceView"))

/**
 * The comments of the file on screen: the library's panel as an aside
 * beside the editor on a desktop (`compact` false), or its sheet from the
 * bottom on a phone (CommentsSurfaceView.tsx). Mounted with the project, it
 * starts loading them; a panel opened before they arrive shows its frame
 * with a loading line.
 */
export function CommentsSurface({ compact, className }: { compact: boolean; className?: string }) {
  const { module } = useModule(surfaceView, true)
  const guest = useContext(GuestContext)
  const ui = useCommentsUi()
  if (module) {
    const { CommentsSurfaceView } = module
    return <CommentsSurfaceView compact={compact} className={className} />
  }
  const open = guest ? guest.open : ui.panelOpen
  if (compact || !open) return null
  return (
    <FloatingPanel className={cn("flex h-full w-[320px] max-w-full shrink-0 flex-col overflow-hidden", className)}>
      <LoadingLine label="Loading comments" />
    </FloatingPanel>
  )
}
