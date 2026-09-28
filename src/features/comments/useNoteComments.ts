import { useDeferredValue, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useCommentsUi, useFileThreads, useProjectComments } from "./context"
import type { CommentFile, ThreadPlace } from "./controller"
import { DRAFT_MARK, noteMarks, notePlaces, type CommentMark } from "./noteMarks"
import { MAX_QUOTE_LENGTH, sectionAnchor, textAnchor } from "./placement"

/** What a view asks to comment on: a selection in the source, or the heading line holding `offset`. */
export type NoteCommentRequest = { kind: "text"; from: number; to: number } | { kind: "section"; offset: number }

export type NoteComments = {
  /** Comment actions are offered: a file on the server, and the person may write comments now. */
  canComment: boolean
  /** The commented text to mark, placed in `marksSource`. */
  marks: readonly CommentMark[]
  /** The text the marks were placed in. A view showing other text waits for the next marks. */
  marksSource: string
  /** A highlight or marker was chosen: the panel opens at its thread. */
  open(threadId: string): void
  /**
   * Start a comment on part of `source`, the text the view shows: the panel
   * opens with a new comment on it. Returns why it cannot, or null.
   */
  comment(request: NoteCommentRequest, source: string): string | null
}

const NO_MARKS: readonly CommentMark[] = []

/**
 * A note's comments, for the session that shows it. While the note is on
 * screen (`active`) it is the panel's file; its threads load the first time
 * it is, and each is placed in the text on screen (unsaved edits included),
 * for the panel and for the marks. `onReveal` runs when the panel asks to
 * show a thread's text.
 */
export function useNoteComments({
  path,
  server,
  active,
  text,
  onReveal,
}: {
  path: string
  /** The server's id and version for the file, or null when the server does not have it yet. */
  server: { id: string; version: number } | null | undefined
  active: boolean
  text: string
  onReveal: (mark: CommentMark) => void
}): NoteComments {
  const comments = useProjectComments()
  const ui = useCommentsUi()
  const serverId = server?.id ?? null
  const serverVersion = server?.version ?? null
  const file = useMemo<CommentFile | null>(
    () => (comments && serverId !== null && serverVersion !== null ? { path, fileId: serverId, fileVersion: serverVersion } : null),
    [comments, path, serverId, serverVersion],
  )
  // Threads load once the note has been on screen, and stay current after.
  const [shown, setShown] = useState(active)
  if (active && !shown) setShown(true)
  const { threads } = useFileThreads(shown && file ? file.fileId : null)
  // Placing every thread runs as the text changes; a deferred copy keeps typing quick.
  const source = useDeferredValue(text)
  const places = useMemo(() => notePlaces(threads, source), [threads, source])
  const request = ui.request && file && ui.request.file.fileId === file.fileId ? ui.request : null
  const marks = useMemo(
    () => (threads.length === 0 && !request ? NO_MARKS : noteMarks(threads, places, ui.activeThreadId, request && { anchor: request.anchor, source })),
    [places, request, source, threads, ui.activeThreadId],
  )

  // The note on screen is the panel's file. Another file's view takes over
  // when it is shown; leaving clears it only if no other view has.
  useEffect(() => {
    if (comments && active) comments.controller.show({ path, file })
  }, [active, comments, file, path])
  useEffect(() => {
    if (!comments || !active) return
    return () => comments.controller.leave(path)
  }, [active, comments, path])
  useEffect(() => {
    if (comments && file && shown) comments.controller.place(file.fileId, places)
  }, [comments, file, places, shown])

  const latest = useRef<{ places: ReadonlyMap<string, ThreadPlace>; kinds: ReadonlyMap<string, "text" | "section" | null> }>({ places, kinds: new Map() })
  useLayoutEffect(() => {
    latest.current = {
      places,
      kinds: new Map(threads.map((thread) => [thread.id, thread.anchor.kind === "text" || thread.anchor.kind === "section" ? thread.anchor.kind : null])),
    }
  }, [places, threads])
  const reveal = useEffectEvent(onReveal)
  useEffect(() => {
    if (!comments || !active) return
    return comments.controller.onReveal((threadId) => {
      const range = latest.current.places.get(threadId)?.range
      const kind = latest.current.kinds.get(threadId)
      if (range && kind) reveal({ id: threadId, kind, from: range.start, to: range.end, active: true })
    })
  }, [active, comments])

  const canComment = Boolean(comments?.canWrite && file)
  return {
    canComment,
    marks,
    marksSource: source,
    open(threadId) {
      if (!comments) return
      if (threadId === DRAFT_MARK) comments.controller.setPanelOpen(true)
      else comments.controller.openThread(threadId)
    },
    comment(request, text) {
      if (!comments || !file || !comments.canWrite) return null
      if (request.kind === "section") {
        try {
          const anchor = sectionAnchor(text, request.offset)
          comments.controller.requestComment({ file, anchor, text: text.slice(anchor.position.start, anchor.position.end) })
          return null
        } catch {
          return "Put the cursor on a heading to comment on its section."
        }
      }
      // Leave out the spaces and line breaks at either end of the selection.
      let from = request.from
      let to = request.to
      while (from < to && /\s/.test(text[from])) from++
      while (to > from && /\s/.test(text[to - 1])) to--
      if (from >= to) return "Select some text to comment on."
      if (to - from > MAX_QUOTE_LENGTH) return "A comment can quote at most 5,000 characters. Select less, or comment on its section."
      const anchor = textAnchor(text, from, to)
      comments.controller.requestComment({ file, anchor, text: anchor.quote.exact })
      return null
    },
  }
}
