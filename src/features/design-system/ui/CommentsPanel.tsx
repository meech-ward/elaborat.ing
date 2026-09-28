import { ChevronRight, CircleAlert, CloudOff, Eye, MessageSquare, MessageSquarePlus, X } from "lucide-react"
import { useId, useRef, type ReactElement, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { Banner } from "./Banner"
import { CommentsSizeContext, type CommentsSize } from "./commentTypes"
import { EmptyState } from "./EmptyState"
import { FloatingPanel, type FloatingPanelProps } from "./FloatingPanel"
import { IconButton } from "./IconButton"
import { LoadingLine } from "./LoadingLine"

// The comments of one file, as a floating panel beside the file on desktop
// and as a sheet from the bottom on phones. Both hold the same body: the
// open threads, then the resolved ones folded under their count, or the
// panel's states (loading, empty, needs a connection, failed). The panel is
// the library's FloatingPanel; the sheet is shadcn's Sheet; the folding is
// shadcn's Collapsible.

/** Loading: the first list is on its way. Offline: comments need a connection. Error: the list failed to load. */
export type CommentsStatus = "loading" | "ready" | "offline" | "error"

export type CommentsBodyProps = {
  /** The open threads, as CommentThread elements (with keys), newest activity first or in file order. */
  openThreads: readonly ReactElement[]
  resolvedThreads?: readonly ReactElement[]
  status?: CommentsStatus
  /** Viewers read comments and can't write: no new-comment button, and a line saying why. */
  readOnly?: boolean
  /** A CommentDraft being written, shown first. */
  draft?: ReactNode
  /** Start a comment on the whole file; shows the header button and the empty state's action. */
  onCommentOnFile?: () => void
  /** What the file is, in "Comment on the whole note": note, drawing, diagram or file. */
  fileNoun?: string
  onRetry?: () => void
  /** Show the resolved threads unfolded at first. */
  defaultResolvedOpen?: boolean
  /**
   * What just happened, for screen readers ("Reply sent", "Thread resolved,
   * moved to Resolved", "2 new comments"): read out politely when it
   * changes. Not for every keystroke.
   */
  announcement?: string
  size?: CommentsSize
}

type HeaderProps = {
  title: ReactNode
  count: number
  onCommentOnFile?: () => void
  fileNoun: string
  readOnly: boolean
  size: CommentsSize
  close?: ReactNode
}

function CommentsHeader({ title, count, onCommentOnFile, fileNoun, readOnly, size, close }: HeaderProps) {
  const touch = size === "touch"
  return (
    <div className={cn("flex shrink-0 items-center gap-2 border-b border-border", touch ? "h-14 pr-2.5 pl-4" : "h-12 pr-2 pl-3.5")}>
      <MessageSquare aria-hidden="true" className={cn("shrink-0 text-muted-foreground", touch ? "size-5" : "size-4")} />
      {title}
      {count > 0 && (
        <span className="font-mono text-xs text-dim tabular-nums">
          {count}
          <span className="sr-only"> open</span>
        </span>
      )}
      <span className="ml-auto flex items-center gap-0.5">
        {onCommentOnFile && !readOnly && (
          <IconButton label={`Comment on the whole ${fileNoun}`} onClick={onCommentOnFile} className={cn(touch && "size-10 [&_svg]:size-5")}>
            <MessageSquarePlus />
          </IconButton>
        )}
        {close}
      </span>
    </div>
  )
}

/** The small uppercase label over a group, with its count: OPEN 2. */
function GroupLabel({ id, children, count }: { id?: string; children: ReactNode; count: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] leading-none font-semibold tracking-[0.07em] text-dim uppercase">
      <span id={id}>{children}</span>
      <span className="font-mono font-normal tracking-normal">{count}</span>
    </span>
  )
}

function ThreadList({ threads, labelledBy, size }: { threads: readonly ReactElement[]; labelledBy: string; size: CommentsSize }) {
  return (
    <ul aria-labelledby={labelledBy} className={cn("flex flex-col", size === "touch" ? "gap-2.5" : "gap-2")}>
      {threads.map((thread) => (
        <li key={thread.key}>{thread}</li>
      ))}
    </ul>
  )
}

/** Two thread-shaped placeholders while the first list loads. */
function ThreadSkeletons() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-2.5 rounded-menu border border-border p-3">
          <Skeleton className="h-3.5 w-3/4 rounded-row" />
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-3 w-24 rounded-row" />
          </div>
          <Skeleton className="h-3 w-full rounded-row" />
          <Skeleton className="h-3 w-2/3 rounded-row" />
        </div>
      ))}
    </div>
  )
}

function CommentsBody({
  openThreads,
  resolvedThreads = [],
  status = "ready",
  readOnly = false,
  draft,
  onCommentOnFile,
  fileNoun = "note",
  onRetry,
  defaultResolvedOpen = false,
  announcement,
  size = "default",
}: CommentsBodyProps) {
  const openId = useId()
  const resolvedId = useId()
  const touch = size === "touch"
  const empty = openThreads.length === 0 && resolvedThreads.length === 0 && !draft
  let content: ReactNode
  if (empty && status === "loading") {
    content = <ThreadSkeletons />
  } else if (empty && status === "offline") {
    content = (
      <EmptyState
        icon={<CloudOff />}
        title="Comments need a connection"
        description="They show here when you are back online."
        className="py-10"
      />
    )
  } else if (empty && status === "error") {
    content = (
      <EmptyState
        icon={<CircleAlert />}
        title="Comments did not load"
        description="Check your connection and try again."
        actions={
          onRetry && (
            <Button variant="secondary" size={touch ? "touch" : "default"} onClick={onRetry}>
              Try again
            </Button>
          )
        }
        className="py-10"
      />
    )
  } else if (empty) {
    content = (
      <EmptyState
        icon={<MessageSquare />}
        title="No comments yet"
        description={
          readOnly
            ? `When someone comments on this ${fileNoun}, it shows here.`
            : fileNoun === "drawing" || fileNoun === "diagram"
              ? `Select an element and choose Comment, or comment on the whole ${fileNoun}.`
              : `Select text or a heading and choose Comment, or comment on the whole ${fileNoun}.`
        }
        actions={
          onCommentOnFile &&
          !readOnly && (
            <Button variant="secondary" size={touch ? "touch" : "default"} onClick={onCommentOnFile}>
              Comment on the whole {fileNoun}
            </Button>
          )
        }
        className="py-10"
      />
    )
  } else {
    content = (
      <>
        {status === "offline" && (
          <Banner tone="info" className={touch ? "text-[14px]" : undefined}>
            Comments need a connection. These may be out of date.
          </Banner>
        )}
        {status === "error" && (
          <Banner tone="danger" action={onRetry && <BannerRetry onRetry={onRetry} />}>
            Comments did not refresh.
          </Banner>
        )}
        {(openThreads.length > 0 || draft) && (
          <div className="flex flex-col gap-2">
            <div className="flex h-6 items-center px-1">
              <GroupLabel id={openId} count={openThreads.length}>
                Open
              </GroupLabel>
            </div>
            {draft}
            {openThreads.length > 0 && <ThreadList threads={openThreads} labelledBy={openId} size={size} />}
          </div>
        )}
        {resolvedThreads.length > 0 && (
          <Collapsible defaultOpen={defaultResolvedOpen} className="flex flex-col gap-2">
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size={touch ? "touch" : "xs"}
                  data-comments-resolved=""
                  className={cn(
                    "justify-start self-start rounded-row px-1 text-dim hover:text-foreground [&[data-panel-open]>svg]:rotate-90 [&>svg]:transition-transform motion-reduce:[&>svg]:transition-none",
                    touch ? "-ml-1 px-1.5" : "pointer-coarse:h-10",
                  )}
                />
              }
            >
              <ChevronRight aria-hidden="true" />
              <GroupLabel id={resolvedId} count={resolvedThreads.length}>
                Resolved
              </GroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ThreadList threads={resolvedThreads} labelledBy={resolvedId} size={size} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </>
    )
  }
  return (
    <CommentsSizeContext value={size}>
      {status === "loading" && <LoadingLine label="Loading comments" className="shrink-0" />}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ScrollArea className="min-h-0 flex-1">
        <div data-slot="comments-body" className={cn("flex flex-col", touch ? "gap-4 p-3 pb-6" : "gap-3.5 p-2.5")}>
          {content}
        </div>
      </ScrollArea>
      {readOnly && (
        <p
          className={cn(
            "flex shrink-0 items-center gap-2 border-t border-border text-muted-foreground",
            touch ? "px-4 py-3 text-[13px]" : "px-3.5 py-2.5 text-xs",
          )}
        >
          <Eye aria-hidden="true" className="size-3.5 shrink-0" />
          You can read comments. Writing them needs commenter access.
        </p>
      )}
    </CommentsSizeContext>
  )
}

function BannerRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="inline" size="inline" onClick={onRetry}>
      Try again
    </Button>
  )
}

export type CommentsPanelProps = CommentsBodyProps &
  Omit<FloatingPanelProps, "children" | "title"> & {
    title?: string
    /** The title's element, to fit the page's heading levels. */
    headingLevel?: 2 | 3 | 4
    /** Shows the close button. */
    onClose?: () => void
  }

/**
 * The desktop panel: a FloatingPanel (radius 14, the panel shadow), 320
 * wide and as tall as its place gives it. The header (48 high, a line
 * under it): the comment icon, "Comments" at 14/600, the open count, then
 * Comment on the whole note and Close. Its body scrolls: OPEN and its
 * threads, then RESOLVED folded under its count. Viewers get a line at the
 * foot saying they can read only. Render it as an <aside> (`render`) where
 * it sits beside the file.
 */
export function CommentsPanel({
  title = "Comments",
  headingLevel = 2,
  onClose,
  openThreads,
  resolvedThreads,
  status,
  readOnly = false,
  draft,
  onCommentOnFile,
  fileNoun = "note",
  onRetry,
  defaultResolvedOpen,
  announcement,
  size = "default",
  className,
  ...props
}: CommentsPanelProps) {
  const Heading = `h${headingLevel}` as const
  return (
    <FloatingPanel data-slot="comments-panel" className={cn("flex w-[320px] max-w-full flex-col overflow-hidden", className)} {...props}>
      <CommentsHeader
        title={<Heading className="text-sm leading-none font-semibold">{title}</Heading>}
        count={openThreads.length}
        onCommentOnFile={onCommentOnFile}
        fileNoun={fileNoun}
        readOnly={readOnly}
        size={size}
        close={
          onClose && (
            <IconButton label="Close comments" onClick={onClose}>
              <X />
            </IconButton>
          )
        }
      />
      <CommentsBody
        openThreads={openThreads}
        resolvedThreads={resolvedThreads}
        status={status}
        readOnly={readOnly}
        draft={draft}
        onCommentOnFile={onCommentOnFile}
        fileNoun={fileNoun}
        onRetry={onRetry}
        defaultResolvedOpen={defaultResolvedOpen}
        announcement={announcement}
        size={size}
      />
    </FloatingPanel>
  )
}

export type CommentsSheetProps = Omit<CommentsBodyProps, "size"> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  /** Where the sheet renders: the body by default (a style guide sample passes its phone frame). */
  container?: HTMLElement | null
  /** False keeps the page usable behind it (the style guide's sample). */
  modal?: boolean
  /** Classes for the sheet, e.g. `absolute` in a frame, or another height. */
  className?: string
  overlayClassName?: string
  /** Makes it a picture of the sheet (the style guide's): no dialog role, nothing to reach. */
  inert?: boolean
}

/**
 * The phone's comments: shadcn's Sheet from the bottom, 75% of the screen
 * high, radius 14 at the top with a grab bar, the panel shadow. The page
 * behind is dimmed but not blurred, so the commented text above it reads. The same body as the panel
 * at the touch size: 15px text, 40px targets, a 56 high header with a 40px
 * Close, which takes focus when it opens. A thread's Go to should close
 * the sheet (or the page lower it) so the commented text shows.
 */
export function CommentsSheet({
  open,
  onOpenChange,
  title = "Comments",
  container,
  modal,
  className,
  overlayClassName,
  openThreads,
  resolvedThreads,
  status,
  readOnly = false,
  draft,
  onCommentOnFile,
  fileNoun = "note",
  onRetry,
  defaultResolvedOpen,
  announcement,
  inert,
}: CommentsSheetProps) {
  const close = useRef<HTMLButtonElement>(null)
  return (
    <Sheet open={open} onOpenChange={(next) => onOpenChange(next)} modal={modal}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        container={container}
        initialFocus={close}
        inert={inert}
        aria-hidden={inert || undefined}
        // No blur: the commented text above the sheet stays readable.
        overlayClassName={cn("supports-backdrop-filter:backdrop-blur-none", overlayClassName)}
        className={cn("gap-0 overflow-hidden rounded-t-panel border-x border-border p-0 shadow-panel data-[side=bottom]:h-[75svh]", className)}
      >
        <div aria-hidden="true" className="flex shrink-0 justify-center pt-2">
          <span className="h-1 w-9 rounded-pill bg-border" />
        </div>
        <CommentsHeader
          title={<SheetTitle className="text-[17px] leading-none font-semibold">{title}</SheetTitle>}
          count={openThreads.length}
          onCommentOnFile={onCommentOnFile}
          fileNoun={fileNoun}
          readOnly={readOnly}
          size="touch"
          close={
            <SheetClose render={<Button ref={close} variant="ghost" size="icon-lg" aria-label="Close comments" />}>
              <X aria-hidden="true" />
            </SheetClose>
          }
        />
        <SheetDescription className="sr-only">The comments on this {fileNoun}.</SheetDescription>
        <CommentsBody
          openThreads={openThreads}
          resolvedThreads={resolvedThreads}
          status={status}
          readOnly={readOnly}
          draft={draft}
          onCommentOnFile={onCommentOnFile}
          fileNoun={fileNoun}
          onRetry={onRetry}
          defaultResolvedOpen={defaultResolvedOpen}
          announcement={announcement}
          size="touch"
        />
      </SheetContent>
    </Sheet>
  )
}
