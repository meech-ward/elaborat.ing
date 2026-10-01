import { CloudUpload, LogIn } from "lucide-react"
import { useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import {
  CommentDraft,
  CommentsPanel,
  CommentsSheet,
  CommentThread,
  EmptyState,
  type CommentsPanelProps,
  type CommentsStatus,
} from "@/features/design-system"
import { useAgentChanges } from "@/features/agent-changes"
import { cn } from "@/lib/utils"
import { anchorView } from "../anchorView"
import { NEEDS_CONNECTION, useCommentsUi, useProjectComments } from "../context"
import type { CommentRequest } from "../controller"
import { afterRender, focusThread, GuestContext, SURFACE, TOGGLE, useFileComments } from "./CommentsSurface"
import { newComments, type ThreadView } from "./threadViews"

// The comments panel and sheet (CommentsSurface.tsx), in a chunk of their
// own that loads once the project has shown.

/**
 * The comments of the file on screen: the library's panel as an aside
 * beside the editor on a desktop (`compact` false), or its sheet from the
 * bottom on a phone. Always mounted: it moves focus to a thread a marker
 * opens, and reads out what changed. CommentsSurface.tsx answers ⌘⌥M /
 * Ctrl+Alt+M, before this chunk has arrived too.
 */
export function CommentsSurfaceView({ compact, className }: { compact: boolean; className?: string }) {
  const comments = useProjectComments()
  const agentChanges = useAgentChanges()
  const guest = useContext(GuestContext)
  const ui = useCommentsUi()
  const { file, fileId, elementsId, threads, status, views, noun } = useFileComments(comments, ui)
  const controller = comments?.controller ?? null
  const store = comments?.store ?? null
  const open = guest ? guest.open : ui.panelOpen
  const setOpen = (next: boolean) => (guest ? guest.onOpenChange(next) : controller?.setPanelOpen(next))
  const [announcement, setAnnouncement] = useState("")
  const said = useRef(0)
  const say = (text: string) => {
    // A trailing space tells two same messages apart, so both are read out.
    setAnnouncement(`${text}${++said.current % 2 ? "" : " "}`)
  }

  // A marker or a highlight's thread takes the keyboard.
  useEffect(() => controller?.onFocusThread(focusThread), [controller])

  // On a phone the sheet covers the bottom half while a comment is written,
  // and the file ends above it (workbench.css). Once the file has made room,
  // it shows the new comment's text or element there.
  const newRequest = compact && open ? ui.request : null
  useEffect(() => {
    if (!newRequest || !controller) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => controller.revealRequest())
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [controller, newRequest])

  // A list that failed offline loads again when the connection is back.
  const online = comments?.online ?? false
  useEffect(() => {
    for (const id of [fileId, elementsId]) if (store && id && online && store.status(id) === "error") void store.load(id)
  }, [store, fileId, elementsId, online])

  // Comments that arrive from elsewhere are read out: "2 new comments".
  const known = useRef<{ fileId: string | null; ids: Set<string> | null }>({ fileId: null, ids: null })
  const userId = comments?.userId ?? null
  const owner = comments?.owner ?? false
  useEffect(() => {
    if (status !== "loaded") return
    const seen = known.current
    if (seen.fileId !== fileId || !seen.ids) {
      known.current = { fileId, ids: new Set(threads.flatMap((thread) => thread.comments.map((comment) => comment.id))) }
      return
    }
    const count = newComments(threads, seen.ids, { userId, owner })
    for (const thread of threads) for (const comment of thread.comments) seen.ids.add(comment.id)
    if (count > 0) setAnnouncement(count === 1 ? "1 new comment" : `${count} new comments`)
  }, [fileId, owner, status, threads, userId])

  // One id per new comment and per reply until it is sent, so sending again after a lost answer never posts twice.
  const [draftIds] = useState(() => new WeakMap<CommentRequest, string>())
  const [replyIds] = useState(() => new Map<string, string>())

  if (!comments && !guest) return null
  if (!ui.target && !guest) return null

  const canWrite = comments?.canWrite ?? false
  const request = ui.request && fileId && (ui.request.file.fileId === fileId || ui.request.file.fileId === elementsId) ? ui.request : null
  const problem = (what: string, error: unknown) => say(`${what}: ${error instanceof Error ? error.message : String(error)}`)

  // "Changed in version n" opens Agent changes at that version of the thread's file.
  const openVersion = (threadId: string) => {
    const threadFile = threads.find((thread) => thread.id === threadId)?.file_id
    if (!agentChanges || !threadFile) return undefined
    return (version: number) => {
      // On a phone the sheet goes, so the view's sheet takes its place.
      if (compact) controller?.setPanelOpen(false)
      agentChanges.show({ fileId: threadFile, version })
    }
  }

  const threadElement = (thread: ThreadView): ReactElement => (
    <CommentThread
      key={thread.id}
      data-thread-id={thread.id}
      anchor={thread.anchor}
      comments={thread.comments}
      resolved={thread.resolved}
      active={ui.activeThreadId === thread.id}
      canWrite={canWrite}
      onSelect={() => {
        // On a phone the sheet goes, so the commented text shows.
        if (compact) controller?.setPanelOpen(false)
        controller?.reveal(thread.id)
      }}
      onResolve={async () => {
        try {
          await store?.resolve(thread.id)
          if (ui.activeThreadId === thread.id) controller?.select(null)
          say("Thread resolved, moved to Resolved")
        } catch (error) {
          problem("Not resolved", error)
        }
      }}
      onReopen={async () => {
        try {
          await store?.reopen(thread.id)
          say("Thread reopened")
          // It moves back to Open: the keyboard goes with it.
          focusThread(thread.id)
        } catch (error) {
          problem("Not reopened", error)
        }
      }}
      askAgent={thread.askAgent}
      onOpenVersion={openVersion(thread.id)}
      onAskAgentChange={
        thread.own
          ? async (ask) => {
              try {
                await store?.setAskAgent(thread.id, ask)
                say(ask ? "Your agent is asked about this thread" : "Your agent is no longer asked")
              } catch (error) {
                problem("Not changed", error)
              }
            }
          : undefined
      }
      onReply={async (body) => {
        const commentId = replyIds.get(thread.id) ?? crypto.randomUUID()
        replyIds.set(thread.id, commentId)
        await store?.reply(thread.id, commentId, body)
        replyIds.delete(thread.id)
        say("Reply sent")
      }}
      onEdit={async (commentId, body) => {
        await store?.edit(commentId, body)
        say("Comment saved")
      }}
      onDelete={async (commentId) => {
        try {
          const result = await store?.deleteComment(commentId)
          say(result?.threadDeleted ? "Comment deleted, and its thread with it" : "Comment deleted")
        } catch (error) {
          problem("Not deleted", error)
        }
      }}
    />
  )

  let draft: ReactNode = null
  if (request && store && controller) {
    const threadId = draftIds.get(request) ?? crypto.randomUUID()
    draftIds.set(request, threadId)
    draft = (
      <CommentDraft
        anchor={request.anchor.kind === "document" ? { kind: "document", label: `Whole ${noun}` } : anchorView(request.anchor, { attached: true, text: request.text })}
        disabledReason={online ? null : NEEDS_CONNECTION}
        offerAskAgent
        onSubmit={async (body, { askAgent }) => {
          const thread = await store.add({ threadId, fileId: request.file.fileId, fileVersion: request.file.fileVersion, anchor: request.anchor, body, askAgent })
          controller.finishRequest(thread.id)
          say("Comment added")
          focusThread(thread.id)
        }}
        onCancel={() => {
          controller.finishRequest()
          afterRender(() => document.querySelector<HTMLElement>(SURFACE)?.focus())
        }}
      />
    )
  }

  let panelStatus: CommentsStatus = "ready"
  if (comments && !online) panelStatus = "offline"
  else if (status === "loading") panelStatus = "loading"
  else if (status === "error") panelStatus = "error"

  const placeholder = guest ? (
    <EmptyState icon={<LogIn />} title="Comments need an account" description="Sign up to comment and to read what others say." actions={guest.signUp} className="py-10" />
  ) : ui.target && !file ? (
    <EmptyState icon={<CloudUpload />} title="Not synced yet" description={`Comments start once this ${noun} is on the server.`} className="py-10" />
  ) : undefined

  const body: Omit<CommentsPanelProps, "title" | "headingLevel" | "onClose"> = {
    openThreads: views.open.map(threadElement),
    resolvedThreads: views.resolved.map(threadElement),
    status: panelStatus,
    readOnly: comments?.viewer ? true : comments && online && !canWrite && comments.writeBlocked ? comments.writeBlocked : false,
    placeholder,
    draft,
    onCommentOnFile: canWrite && file && controller ? () => controller.requestComment({ file, anchor: { kind: "document" } }) : undefined,
    fileNoun: noun,
    onRetry: () => {
      for (const id of [fileId, elementsId]) if (store && id) void store.load(id)
    },
    announcement,
  }

  if (compact) return <CommentsSheet open={open} onOpenChange={(next) => setOpen(next)} {...body} />
  if (!open) return null
  const close = () => {
    setOpen(false)
    document.querySelector<HTMLElement>(TOGGLE)?.focus()
  }
  return (
    <CommentsPanel
      render={<aside aria-label="Comments" tabIndex={-1} data-comments-surface="" />}
      className={cn(
        "h-full shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
        className,
      )}
      // Escape closes the panel, as it closes the sheet; a field or a menu in it takes Escape first.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
        if (event.target instanceof HTMLElement && event.target.closest("textarea, input")) return
        event.preventDefault()
        close()
      }}
      {...body}
      onClose={close}
    />
  )
}
