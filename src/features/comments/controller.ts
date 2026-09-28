import type { TextRange } from "./anchoring"
import type { CommentAnchor } from "./placement"

// What the comments panel and the file on screen tell each other, for one
// open project. The file view knows the text on screen, so it works out where
// each thread is now and reports it (`place`); the panel lists the threads and
// asks the file to show one (`reveal`). A marker or highlight in the file
// opens the panel at its thread (`openThread`), and a selection's Comment
// action opens it with a new comment on that text (`requestComment`).
//
// Plain state and events, no React: context.tsx reads it with
// useSyncExternalStore.

/** A file comments can be on: one the server has, so it has the server's id. */
export type CommentFile = {
  path: string
  /** The server's id for the file. Threads hang off it, so they follow renames and moves. */
  fileId: string
  /** The saved version the text on screen is based on: a new thread records it. */
  fileVersion: number
}

/**
 * The file on screen. `file` is null when it cannot have comments yet (not
 * on the server). `elements` is the file its drawing elements' comments hang
 * on when that is another file: a D2 diagram's generated canvas. The panel
 * lists both files' threads.
 */
export type CommentTarget = { path: string; file: CommentFile | null; elements?: CommentFile | null }

/**
 * Where a thread is in the text on screen now. `attached: false` is a
 * detached thread: its text, heading or element is gone, and the panel shows
 * it with its stored quote. `text` is what the anchor covers now: the quoted
 * text, or a heading's words. `range` is its place in the source.
 */
export type ThreadPlace = { attached: boolean; text?: string; range?: TextRange }

/** A comment being started on part of a file: the panel opens with a draft for it. */
export type CommentRequest = {
  file: CommentFile
  anchor: CommentAnchor
  /** What the anchor covers, as the draft shows it: the selected text, or the heading's words. */
  text?: string
}

export type CommentsUiState = {
  /** The file the panel lists threads for: the one on screen. */
  target: CommentTarget | null
  panelOpen: boolean
  /** The thread open in the panel; its text is marked more strongly in the file. */
  activeThreadId: string | null
  /** A new comment waiting for its words, or null. */
  request: CommentRequest | null
}

const INITIAL: CommentsUiState = { target: null, panelOpen: false, activeThreadId: null, request: null }
const NO_PLACES: ReadonlyMap<string, ThreadPlace> = new Map()

type Listener = () => void
type ThreadListener = (threadId: string) => void
type RequestListener = (request: CommentRequest) => void

export class CommentsController {
  private state: CommentsUiState = INITIAL
  private readonly places = new Map<string, ReadonlyMap<string, ThreadPlace>>()
  private readonly listeners = new Set<Listener>()
  private readonly revealListeners = new Set<ThreadListener>()
  private readonly focusListeners = new Set<ThreadListener>()
  private readonly requestListeners = new Set<RequestListener>()

  /** Calls `listener` after every change to the state or the places. Returns an unsubscribe function. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): CommentsUiState => this.state

  // --- From the file on screen ---

  /**
   * The file view that became active says what it shows. Showing another
   * file closes its thread and drops a new comment started on the last one.
   */
  show(target: CommentTarget): void {
    const current = this.state.target
    if (current && current.path === target.path && sameFile(current.file, target.file) && sameFile(current.elements ?? null, target.elements ?? null)) return
    const sameFileId = current?.file?.fileId !== undefined && current.file.fileId === target.file?.fileId
    const request = this.state.request
    this.set({
      target,
      activeThreadId: sameFileId ? this.state.activeThreadId : null,
      request: request && (request.file.fileId === target.file?.fileId || request.file.fileId === target.elements?.fileId) ? request : null,
    })
  }

  /** The file view at `path` is no longer on screen. */
  leave(path: string): void {
    if (this.state.target?.path !== path) return
    this.set({ target: null, activeThreadId: null, request: null })
  }

  /** Where each thread of a file is in the text on screen now, by thread id. */
  place(fileId: string, places: ReadonlyMap<string, ThreadPlace>): void {
    const before = this.places.get(fileId)
    if (before && samePlaces(before, places)) return
    this.places.set(fileId, places)
    this.notify()
  }

  /**
   * A marker or commented text was chosen: open the panel at its thread. With
   * `focus` (a marker, a button) the keyboard moves to the thread; a click in
   * the text leaves it there.
   */
  openThread(threadId: string, focus = true): void {
    this.set({ panelOpen: true, activeThreadId: threadId })
    if (focus) for (const listener of this.focusListeners) listener(threadId)
  }

  /** The Comment action on a selection or a heading: open the panel with a new comment on it. */
  requestComment(request: CommentRequest): void {
    this.set({ panelOpen: true, activeThreadId: null, request })
  }

  // --- From the panel ---

  /** Where the file view last found each of a file's threads. Threads it has not placed are missing. */
  placesFor(fileId: string): ReadonlyMap<string, ThreadPlace> {
    return this.places.get(fileId) ?? NO_PLACES
  }

  setPanelOpen(open: boolean): void {
    this.set(open ? { panelOpen: true } : { panelOpen: false, activeThreadId: null, request: null })
  }

  /** The thread open in the panel, or null. */
  select(threadId: string | null): void {
    this.set({ activeThreadId: threadId })
  }

  /** Show a thread's text in the file: it scrolls into view and flashes, and the file takes the keyboard. */
  reveal(threadId: string): void {
    this.set({ activeThreadId: threadId })
    for (const listener of this.revealListeners) listener(threadId)
  }

  /**
   * Show the new comment's text or element in the file, without taking the
   * keyboard from its field: on a phone, once the sheet has made room for it
   * above (the file ends where the sheet starts while a comment is written).
   */
  revealRequest(): void {
    const request = this.state.request
    if (request) for (const listener of this.requestListeners) listener(request)
  }

  /** The new comment was sent (it is now the thread `threadId`) or given up (no id). */
  finishRequest(threadId?: string): void {
    this.set({ request: null, ...(threadId ? { activeThreadId: threadId } : {}) })
  }

  // --- Events ---

  /** The file views listen: show this thread's text. Returns an unsubscribe function. */
  onReveal(listener: ThreadListener): () => void {
    this.revealListeners.add(listener)
    return () => this.revealListeners.delete(listener)
  }

  /** The file views listen: show the new comment's text or element, leaving the keyboard where it is. Returns an unsubscribe function. */
  onRevealRequest(listener: RequestListener): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  /** The panel listens: scroll to this thread and move the keyboard to it. Returns an unsubscribe function. */
  onFocusThread(listener: ThreadListener): () => void {
    this.focusListeners.add(listener)
    return () => this.focusListeners.delete(listener)
  }

  private set(change: Partial<CommentsUiState>) {
    const next = { ...this.state, ...change }
    if ((Object.keys(next) as (keyof CommentsUiState)[]).every((key) => next[key] === this.state[key])) return
    this.state = next
    this.notify()
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

function sameFile(a: CommentFile | null, b: CommentFile | null): boolean {
  if (a === null || b === null) return a === b
  return a.path === b.path && a.fileId === b.fileId && a.fileVersion === b.fileVersion
}

function samePlaces(a: ReadonlyMap<string, ThreadPlace>, b: ReadonlyMap<string, ThreadPlace>): boolean {
  if (a.size !== b.size) return false
  for (const [id, place] of a) {
    const other = b.get(id)
    if (
      !other ||
      other.attached !== place.attached ||
      other.text !== place.text ||
      other.range?.start !== place.range?.start ||
      other.range?.end !== place.range?.end
    )
      return false
  }
  return true
}
