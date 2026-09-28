import { Bot, Check, CircleCheck, Ellipsis, FileText, Heading, Reply, RotateCcw, Shapes, UserRound } from "lucide-react"
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertDialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { initialFor } from "./AccountRows"
import { ActionMenu, type MenuEntry } from "./ActionMenu"
import { CommentComposer } from "./CommentComposer"
import { DetachedBadge } from "./CommentMarker"
import { absoluteTime, relativeTime } from "./commentText"
import {
  useCommentsSize,
  type CommentAnchorView,
  type CommentAuthor,
  type CommentEntry,
  type CommentResolution,
  type CommentsSize,
} from "./commentTypes"
import { IconButton } from "./IconButton"

// A comment thread in the panel: what it is about (its context line), its
// comments, and Resolve or Reopen, Reply, and each comment's Edit and
// Delete. No shadcn primitive is a thread: it is an article laid out around
// shadcn's Avatar, Badge, Button and the library's ActionMenu and
// CommentComposer.

const DELETED_ACCOUNT = "Deleted account"

/** What a detached anchor lost, in the context line. */
const GONE: Record<Exclude<CommentAnchorView["kind"], "document">, string> = {
  text: "Its text is gone",
  section: "Its heading is gone",
  element: "Its element is gone",
}

/** The anchor in a few words, for the thread's accessible name. */
export function anchorSummary(anchor: CommentAnchorView): string {
  switch (anchor.kind) {
    case "document":
      return anchor.label ?? "Whole note"
    case "text":
      return `“${anchor.quote}”`
    case "section":
      return `section ${anchor.heading}`
    case "element":
      return anchor.label
  }
}

const cardSizes: Record<CommentsSize, string> = {
  default: "gap-2.5 p-3",
  touch: "gap-3 p-3.5",
}

/** Runs `then` once React has shown what an action changed. */
function afterRender(then: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(then))
}

/** Whether focus went with something that left the page (it is on the body, or on nothing). */
function focusLost() {
  const active = document.activeElement
  return active === null || active === document.body
}

/** The first control in a thread: Go to, or Resolve. */
function firstControl(thread: Element): HTMLElement | null {
  return thread.querySelector<HTMLElement>("button:not([disabled]), textarea:not([disabled]), [href]")
}

/**
 * The thread's context line. Text: the quote after a 2px accent bar, two
 * lines at most. A section: the heading icon and its text. An element: the
 * shapes icon and its label. The whole file: the file icon and "Whole note".
 * Detached: the badge and what is gone, then the old quote struck through in
 * dim. With `onSelect`, the line is a button that shows the anchor in the
 * file (not when detached: there is nothing to show).
 */
export function CommentAnchorLine({
  anchor,
  onSelect,
  size: sizeProp,
  className,
}: {
  anchor: CommentAnchorView
  onSelect?: () => void
  size?: CommentsSize
  className?: string
}) {
  const size = useCommentsSize(sizeProp)
  const detached = anchor.kind !== "document" && anchor.detached === true
  const text = size === "touch" ? "text-[14px]" : "text-[12.5px]"
  const icon = "mt-[3px] size-3.5 shrink-0 text-dim"
  let line: ReactNode
  switch (anchor.kind) {
    case "document":
      line = (
        <span className="flex min-w-0 items-start gap-1.5">
          <FileText aria-hidden="true" className={icon} />
          <span className="min-w-0 font-medium text-muted-foreground">{anchor.label ?? "Whole note"}</span>
        </span>
      )
      break
    case "text":
      line = (
        <span
          className={cn(
            "line-clamp-2 border-l-2 pl-2 [overflow-wrap:anywhere]",
            detached ? "border-dashed border-faint text-dim line-through decoration-dim" : "border-accent-line text-muted-foreground",
          )}
        >
          “{anchor.quote}”
        </span>
      )
      break
    case "section":
    case "element": {
      const Icon = anchor.kind === "section" ? Heading : Shapes
      line = (
        <span className="flex min-w-0 items-start gap-1.5">
          <Icon aria-hidden="true" className={icon} />
          <span className={cn("min-w-0 truncate font-semibold", detached ? "text-dim line-through decoration-dim" : "text-muted-foreground")}>
            {anchor.kind === "section" ? anchor.heading : anchor.label}
          </span>
        </span>
      )
      break
    }
  }
  const body = (
    <>
      {detached && (
        <span className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <DetachedBadge />
          <span className="text-xs text-dim">{GONE[anchor.kind as keyof typeof GONE]}</span>
        </span>
      )}
      {line}
    </>
  )
  if (onSelect && !detached) {
    // A 40px target on touch screens, its words in the middle.
    return (
      <Button
        variant="ghost"
        onClick={onSelect}
        className={cn(
          "-mx-1.5 block h-auto min-w-0 content-center rounded-row px-1.5 text-left leading-snug font-normal whitespace-normal pointer-coarse:h-auto",
          size === "touch" ? "-my-2 min-h-10 py-1.5" : "-my-1 py-1 pointer-coarse:-my-2 pointer-coarse:min-h-10",
          text,
          className,
        )}
      >
        <span className="sr-only">Go to </span>
        {body}
      </Button>
    )
  }
  return <div className={cn("min-w-0 leading-snug", text, className)}>{body}</div>
}

function CommentAvatar({ author, deleted, size }: { author: CommentAuthor | null; deleted?: boolean; size: CommentsSize }) {
  return (
    <Avatar aria-hidden="true" className={cn("after:hidden", size === "touch" ? "size-8" : "size-6", deleted && "opacity-50")}>
      {author?.image && <AvatarImage src={author.image} alt="" />}
      <AvatarFallback className={cn(size === "touch" ? "text-[13px]" : "text-[11px]", !author && "bg-seg text-dim")}>
        {author ? initialFor(author.name) : <UserRound className="size-3.5" />}
      </AvatarFallback>
    </Avatar>
  )
}

/** When it was written, with the full date on hover. */
function CommentTime({ when, now }: { when: string | Date; now?: Date }) {
  const date = new Date(when)
  return (
    <time dateTime={date.toISOString()} title={absoluteTime(date)} className="whitespace-nowrap">
      {relativeTime(date, now)}
    </time>
  )
}

/**
 * Asks before a comment is deleted, since its words go for good: shadcn's
 * alert dialog, with Cancel focused. `onDelete` runs on Delete.
 */
export function DeleteCommentDialog({
  open,
  onOpenChange,
  onDelete,
  size = "default",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
  size?: CommentsSize
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const button = size === "touch" ? "touch" : "default"
  return (
    <AlertDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent showCloseButton={false} initialFocus={cancel}>
        <DialogTitle>Delete this comment?</DialogTitle>
        <DialogDescription>Its words are removed for everyone, and it cannot be undone.</DialogDescription>
        <DialogFooter>
          <Button ref={cancel} variant="outline" size={button} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={button}
            onClick={() => {
              onOpenChange(false)
              onDelete()
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </AlertDialog>
  )
}

/**
 * One comment: the Avatar (the picture, or the initial in accentSoft; an
 * empty figure for a deleted account), the author's name at 600, "via
 * agent" when their agent wrote it, when (and "edited"), then the words.
 * A deleted comment keeps its author and time, and says "Comment deleted".
 * Its menu (Edit for its author, Delete for its author and the owner) shows
 * on hover and focus, and always on touch screens. Delete asks first.
 */
export function CommentItem({
  comment,
  now,
  editing = false,
  onStartEdit,
  onEdit,
  onCancelEdit,
  onDelete,
  size: sizeProp,
  className,
}: {
  comment: CommentEntry
  now?: Date
  editing?: boolean
  onStartEdit?: () => void
  onEdit?: (body: string) => void | Promise<unknown>
  onCancelEdit?: () => void
  onDelete?: () => void
  size?: CommentsSize
  className?: string
}) {
  const size = useCommentsSize(sizeProp)
  const touch = size === "touch"
  const [confirming, setConfirming] = useState(false)
  const name = comment.author?.name ?? DELETED_ACCOUNT
  const deleted = comment.body === null
  const entries: MenuEntry[] = []
  if (!deleted && comment.canEdit && onStartEdit) entries.push({ label: "Edit", onSelect: onStartEdit })
  if (!deleted && comment.canDelete && onDelete) entries.push({ label: "Delete", destructive: true, onSelect: () => setConfirming(true) })
  const menuLabel = `Actions for the comment by ${name}`
  return (
    <div
      data-slot="comment"
      data-comment-id={comment.id}
      data-deleted={deleted || undefined}
      className={cn("group/comment grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2", touch ? "gap-y-1" : "gap-y-0.5", className)}
    >
      <CommentAvatar author={comment.author} deleted={deleted} size={size} />
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-[normal]", touch ? "min-h-8" : "min-h-6")}>
        <span className={cn("min-w-0 truncate font-semibold", comment.author ? "text-foreground" : "text-muted-foreground", touch ? "text-[15px]" : "text-[13px]")}>
          {name}
        </span>
        {comment.viaAgent && (
          <Badge variant="secondary" title="Written by their agent">
            <Bot data-icon="inline-start" aria-hidden="true" />
            via agent
          </Badge>
        )}
        <span className={cn("text-dim", touch ? "text-[13px]" : "text-xs")}>
          <CommentTime when={comment.createdAt} now={now} />
          {comment.editedAt && !deleted && (
            <span title={`Edited ${absoluteTime(comment.editedAt)}`}>
              {" · "}edited
            </span>
          )}
        </span>
      </div>
      <div className="col-span-2 col-start-2 min-w-0">
        {editing && onEdit ? (
          <CommentComposer
            label="Edit comment"
            placeholder="Edit comment"
            submitLabel="Save"
            defaultValue={comment.body ?? ""}
            requireChange
            onSubmit={onEdit}
            onCancel={onCancelEdit}
            autoFocus
            size={size}
            className="mt-1"
          />
        ) : deleted ? (
          <p className={cn("leading-normal text-dim italic", touch ? "text-[15px]" : "text-[13px]")}>Comment deleted</p>
        ) : (
          <p className={cn("leading-normal whitespace-pre-wrap text-body [overflow-wrap:anywhere]", touch ? "text-[15px]" : "text-[13px]")}>
            {comment.body}
          </p>
        )}
      </div>
      {/* After the words, so a screen reader hears the comment before its
      actions; the grid still draws it at the end of the first row. While
      editing it stays, hidden, so the closing menu does not send focus
      back to some earlier control: the edit field has it. */}
      {entries.length > 0 && (
        <ActionMenu
          entries={entries}
          contentProps={{
            align: "end",
            "aria-label": menuLabel,
            className: "min-w-40",
            finalFocus: () => !editing,
          }}
          trigger={
            <Button
              variant="ghost"
              size={touch ? "icon-lg" : "icon-xs"}
              aria-label={menuLabel}
              title="Comment actions"
              data-comment-menu=""
              className={cn(
                "col-start-3 row-start-1",
                editing && "invisible",
                !touch &&
                  "opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100",
                touch && "-my-1 -mr-2",
              )}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          }
        />
      )}
      {onDelete && <DeleteCommentDialog open={confirming} onOpenChange={setConfirming} onDelete={onDelete} size={size} />}
    </div>
  )
}

export type CommentThreadProps = Omit<ComponentProps<"article">, "children"> & {
  anchor: CommentAnchorView
  /** Oldest first: the first opens the thread, the rest are replies. */
  comments: readonly CommentEntry[]
  /** Set when the thread is resolved. */
  resolved?: CommentResolution | null
  /** The thread shown in the file now: outlined in the accent. */
  active?: boolean
  /** Reply, Resolve and Reopen are offered: commenters and up, while online. */
  canWrite?: boolean
  /** Show the anchor in the file (the context line's button). */
  onSelect?: () => void
  /** Resolve the thread. Focus then moves to the next thread, or to Resolved when none is left. */
  onResolve?: () => void | Promise<unknown>
  onReopen?: () => void | Promise<unknown>
  onReply?: (body: string) => void | Promise<unknown>
  onEdit?: (commentId: string, body: string) => void | Promise<unknown>
  /** Delete a comment. Focus then moves to the thread's Reply, or to the thread. */
  onDelete?: (commentId: string) => void | Promise<unknown>
  /** Open the reply field at first (it opens from Reply otherwise). */
  defaultReplying?: boolean
  /** The time relative times count from; now by default. */
  now?: Date
  size?: CommentsSize
}

/**
 * A thread as a card in the panel: radius 12, the panel border (1px in the
 * accent line when `active`, the field fill once resolved), padding 12. The
 * context line with Resolve (or Reopen) at its end; "Resolved by ..." when
 * resolved; the comments, 10 apart; then Reply, which opens a
 * CommentComposer until the reply is sent or cancelled, or a comment is
 * deleted while it is still empty. Viewers and offline
 * readers (`canWrite` false) see the words only.
 *
 * Focus never falls to the page: closing or sending Reply goes back to Reply, an edit
 * back to its comment's actions, Resolve and Reopen to the next thread (or
 * Resolved), and Delete to Reply or the thread. The card itself takes focus
 * (tabIndex -1) when a marker in the file opens it.
 */
export function CommentThread({
  anchor,
  comments,
  resolved,
  active = false,
  canWrite = true,
  onSelect,
  onResolve,
  onReopen,
  onReply,
  onEdit,
  onDelete,
  defaultReplying = false,
  now,
  size: sizeProp,
  className,
  ...props
}: CommentThreadProps) {
  const size = useCommentsSize(sizeProp)
  const touch = size === "touch"
  const [replying, setReplying] = useState(defaultReplying)
  const [reply, setReply] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const resolvedId = useId()
  const card = useRef<HTMLElement>(null)
  const replyButton = useRef<HTMLButtonElement>(null)
  const toggle = resolved ? onReopen : onResolve

  // Closing Reply (sent or cancelled) gives the keyboard back to Reply once it shows again.
  const replyFocus = useRef(false)
  const closeReply = () => {
    replyFocus.current = true
    setReplying(false)
    setReply("")
  }
  useEffect(() => {
    if (replying || !replyFocus.current) return
    replyFocus.current = false
    replyButton.current?.focus()
  }, [replying])
  const endEdit = (commentId: string) => {
    setEditing(null)
    afterRender(() => card.current?.querySelector<HTMLElement>(`[data-comment-id="${commentId}"] [data-comment-menu=""]`)?.focus())
  }
  /** Resolve or Reopen moves the thread to the other group, so focus goes on to its neighbour. */
  const toggleThread = async () => {
    const item = card.current?.closest("li")
    const neighbour = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector('[data-slot="comment-thread"]') ?? null
    const body = card.current?.closest<HTMLElement>('[data-slot="comments-body"]') ?? null
    await toggle?.()
    afterRender(() => {
      if (!focusLost()) return
      const next =
        (neighbour?.isConnected ? firstControl(neighbour) : null) ??
        body?.querySelector<HTMLElement>("[data-comments-resolved]") ??
        body?.querySelector<HTMLElement>('[data-slot="comment-thread"]')
      next?.focus()
    })
  }
  /**
   * Delete leaves the thread (as a placeholder), or takes it when it was the
   * last comment. A reply field left open with nothing in it closes, as it
   * does once a reply is sent.
   */
  const deleteComment = async (commentId: string) => {
    const item = card.current?.closest("li")
    const neighbour = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector('[data-slot="comment-thread"]') ?? null
    await onDelete?.(commentId)
    const closing = replying && !reply.trim()
    if (closing) setReplying(false)
    afterRender(() => {
      if (!focusLost()) return
      const thread = card.current?.isConnected ? card.current : null
      if (thread && closing && !replyButton.current) {
        // Reply has not shown yet (a busy page can take longer than two frames): it takes the keyboard when it does.
        replyFocus.current = true
        thread.focus()
        return
      }
      const next = thread ? (replyButton.current ?? thread) : neighbour?.isConnected ? firstControl(neighbour) : null
      next?.focus()
    })
  }
  return (
    <article
      ref={card}
      tabIndex={-1}
      data-slot="comment-thread"
      data-active={active || undefined}
      data-resolved={resolved ? true : undefined}
      aria-label={`Comments on ${anchorSummary(anchor)}`}
      aria-describedby={resolved ? resolvedId : undefined}
      className={cn(
        "flex scroll-my-2 flex-col rounded-menu border text-foreground transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring motion-reduce:transition-none",
        cardSizes[size],
        resolved ? "border-border bg-field" : "border-border bg-panel",
        active && "border-accent-line",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-2">
        <CommentAnchorLine anchor={anchor} onSelect={onSelect} size={size} className="flex-1" />
        {canWrite && toggle && (
          <IconButton
            label={resolved ? "Reopen" : "Resolve"}
            tooltipSide="left"
            onClick={() => void toggleThread()}
            className={cn("-my-1 -mr-1.5 shrink-0", touch && "size-10", !resolved && "hover:text-accent-line")}
          >
            {resolved ? <RotateCcw /> : <Check />}
          </IconButton>
        )}
      </div>
      {resolved && (
        <p id={resolvedId} className={cn("-mt-0.5 flex items-center gap-1.5 text-dim", touch ? "text-[13px]" : "text-xs")}>
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
          {/* Who, then when, as a comment's own line shows them: on a narrow panel when goes under who. */}
          <span className="flex min-w-0 flex-wrap gap-x-1.5">
            <span className="min-w-0 [overflow-wrap:anywhere]">Resolved by {resolved.by?.name ?? DELETED_ACCOUNT}</span>
            <CommentTime when={resolved.at} now={now} />
          </span>
        </p>
      )}
      <ol className={cn("flex flex-col", touch ? "gap-3.5" : "gap-2.5")}>
        {comments.map((comment) => (
          <li key={comment.id}>
            <CommentItem
              comment={comment}
              now={now}
              size={size}
              editing={editing === comment.id}
              onStartEdit={canWrite && onEdit ? () => setEditing(comment.id) : undefined}
              onEdit={
                onEdit &&
                (async (body) => {
                  await onEdit(comment.id, body)
                  endEdit(comment.id)
                })
              }
              onCancelEdit={() => endEdit(comment.id)}
              onDelete={canWrite && onDelete ? () => void deleteComment(comment.id) : undefined}
            />
          </li>
        ))}
      </ol>
      {canWrite &&
        onReply &&
        (replying ? (
          <CommentComposer
            label="Reply"
            placeholder="Reply"
            submitLabel="Reply"
            value={reply}
            onValueChange={setReply}
            onSubmit={async (body) => {
              await onReply(body)
              closeReply()
            }}
            onCancel={closeReply}
            autoFocus={!defaultReplying}
            size={size}
          />
        ) : (
          <Button
            ref={replyButton}
            variant="ghost"
            size={touch ? "touch" : "xs"}
            onClick={() => setReplying(true)}
            className={cn("self-start", touch ? "-mb-1 -ml-2 px-2 [&_svg]:size-4" : "-mb-0.5 -ml-1.5 pointer-coarse:h-10")}
          >
            <Reply aria-hidden="true" />
            Reply
          </Button>
        ))}
    </article>
  )
}

/**
 * A new thread being written: the card with a 1px accent-line border, the
 * context line of what it will be on, and the composer, focused. `onSubmit`
 * starts the thread; Cancel drops it.
 */
export function CommentDraft({
  anchor,
  onSubmit,
  onCancel,
  disabledReason,
  autoFocus = true,
  size: sizeProp,
  className,
}: {
  anchor: CommentAnchorView
  onSubmit: (body: string) => void | Promise<unknown>
  onCancel: () => void
  disabledReason?: string | null
  /** The composer takes focus when the draft opens. */
  autoFocus?: boolean
  size?: CommentsSize
  className?: string
}) {
  const size = useCommentsSize(sizeProp)
  return (
    <article
      data-slot="comment-draft"
      aria-label={`New comment on ${anchorSummary(anchor)}`}
      className={cn(
        "flex flex-col rounded-menu border border-accent-line bg-panel text-foreground",
        cardSizes[size],
        className,
      )}
    >
      <CommentAnchorLine anchor={anchor} size={size} />
      <CommentComposer label="New comment" onSubmit={onSubmit} onCancel={onCancel} disabledReason={disabledReason} autoFocus={autoFocus} size={size} />
    </article>
  )
}
