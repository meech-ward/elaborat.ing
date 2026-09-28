import { Bot, Check, CircleCheck, Ellipsis, FileText, Heading, Reply, RotateCcw, Shapes, UserRound } from "lucide-react"
import { useId, useState, type ComponentProps, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
            detached ? "border-dashed border-faint text-dim line-through decoration-dim" : "border-primary text-muted-foreground",
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
    return (
      <Button
        variant="ghost"
        onClick={onSelect}
        className={cn(
          "-mx-1.5 -my-1 block h-auto min-w-0 rounded-row px-1.5 py-1 text-left leading-snug font-normal whitespace-normal pointer-coarse:h-auto",
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
 * One comment: the Avatar (the picture, or the initial in accentSoft; an
 * empty figure for a deleted account), the author's name at 600, "via
 * agent" when their agent wrote it, when (and "edited"), then the words.
 * A deleted comment keeps its author and time, and says "Comment deleted".
 * Its menu (Edit for its author, Delete for its author and the owner) shows
 * on hover and focus, and always on touch screens.
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
  const name = comment.author?.name ?? DELETED_ACCOUNT
  const deleted = comment.body === null
  const entries: MenuEntry[] = []
  if (!deleted && comment.canEdit && onStartEdit) entries.push({ label: "Edit", onSelect: onStartEdit })
  if (!deleted && comment.canDelete && onDelete) entries.push({ label: "Delete", destructive: true, onSelect: onDelete })
  const menuLabel = `Actions for the comment by ${name}`
  return (
    <div
      data-slot="comment"
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
      {entries.length > 0 && !editing ? (
        <ActionMenu
          entries={entries}
          contentProps={{ align: "end", "aria-label": menuLabel, className: "min-w-40" }}
          trigger={
            <Button
              variant="ghost"
              size={touch ? "icon-lg" : "icon-xs"}
              aria-label={menuLabel}
              title="Comment actions"
              className={cn(
                !touch &&
                  "opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100",
                touch && "-my-1 -mr-2",
              )}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          }
        />
      ) : (
        <span />
      )}
      <div className="col-span-2 col-start-2 min-w-0">
        {editing && onEdit ? (
          <CommentComposer
            label="Edit comment"
            placeholder="Edit comment"
            submitLabel="Save"
            defaultValue={comment.body ?? ""}
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
  onResolve?: () => void
  onReopen?: () => void
  onReply?: (body: string) => void | Promise<unknown>
  onEdit?: (commentId: string, body: string) => void | Promise<unknown>
  onDelete?: (commentId: string) => void
  /** Open the reply field at first (it opens from Reply otherwise). */
  defaultReplying?: boolean
  /** The time relative times count from; now by default. */
  now?: Date
  size?: CommentsSize
}

/**
 * A thread as a card in the panel: radius 12, the panel border (the accent
 * when `active`, the field fill once resolved), padding 12. The context line
 * with Resolve (or Reopen) at its end; "Resolved by ..." when resolved; the
 * comments, 10 apart; then Reply, which opens a CommentComposer. Viewers
 * and offline readers (`canWrite` false) see the words only.
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
  const [editing, setEditing] = useState<string | null>(null)
  const resolvedId = useId()
  const toggle = resolved ? onReopen : onResolve
  return (
    <article
      data-slot="comment-thread"
      data-active={active || undefined}
      data-resolved={resolved ? true : undefined}
      aria-label={`Comments on ${anchorSummary(anchor)}`}
      aria-describedby={resolved ? resolvedId : undefined}
      className={cn(
        "flex flex-col rounded-menu border text-foreground transition-colors motion-reduce:transition-none",
        cardSizes[size],
        resolved ? "border-border bg-field" : "border-border bg-panel",
        active && "border-primary shadow-[0_0_0_1px_var(--accent)]",
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
            onClick={toggle}
            className={cn("-my-1 -mr-1.5 shrink-0", touch && "size-10", !resolved && "hover:text-primary")}
          >
            {resolved ? <RotateCcw /> : <Check />}
          </IconButton>
        )}
      </div>
      {resolved && (
        <p id={resolvedId} className={cn("-mt-0.5 flex items-center gap-1.5 text-dim", touch ? "text-[13px]" : "text-xs")}>
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0">
            Resolved by {resolved.by?.name ?? DELETED_ACCOUNT} · <CommentTime when={resolved.at} now={now} />
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
                  setEditing(null)
                })
              }
              onCancelEdit={() => setEditing(null)}
              onDelete={canWrite && onDelete ? () => onDelete(comment.id) : undefined}
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
            onSubmit={onReply}
            onCancel={() => setReplying(false)}
            autoFocus={!defaultReplying}
            size={size}
          />
        ) : (
          <Button
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
 * A new thread being written: the card outlined in the accent, the context
 * line of what it will be on, and the composer, focused. `onSubmit` starts
 * the thread; Cancel drops it.
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
        "flex flex-col rounded-menu border border-primary bg-panel text-foreground shadow-[0_0_0_1px_var(--accent)]",
        cardSizes[size],
        className,
      )}
    >
      <CommentAnchorLine anchor={anchor} size={size} />
      <CommentComposer label="New comment" onSubmit={onSubmit} onCancel={onCancel} disabledReason={disabledReason} autoFocus={autoFocus} size={size} />
    </article>
  )
}
