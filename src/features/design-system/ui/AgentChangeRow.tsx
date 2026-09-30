import { Bot, ChevronRight, FilePen, MessageSquare, RotateCcw, SquareArrowOutUpRight } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { absoluteTime, relativeTime } from "./commentText"
import { KindBadge, type FileKind } from "./KindBadge"

// One change an agent saved, as the Agent changes view lists it (the
// button and its count are in AgentChangesButton.tsx). No shadcn primitive
// is a change: it is an article laid out around shadcn's Avatar, Badge,
// Button and Collapsible.

type Size = "default" | "touch"

/** What an agent did to a file, in the change's file line. */
export type AgentChangeAction = "changed" | "created" | "deleted" | "moved"

export type AgentChangeRowProps = {
  /** The agent's name, or null for one without a name ("An agent"). */
  agent: string | null
  /** The person it saved for: their name, or null for a deleted account. */
  person: string | null
  path: string
  kind: FileKind
  action: AgentChangeAction
  /** Where a moved file was. */
  movedFrom?: string
  /** The file's version this change saved. */
  version: number
  when: string | Date
  now?: Date
  /** New since the person last looked. */
  isNew?: boolean
  /** The thread this change answered: its opening words, and a way to show it. */
  thread?: { opening: string | null; onShow?: () => void } | null
  /** The change's diff (or what shows in its place), under Show changes. */
  children?: ReactNode
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Open the file; without it there is no Open (the file is gone). */
  onOpen?: () => void
  /** Save the file's previous version as a new one; without it there is no Revert (a viewer). */
  onRevert?: () => void
  /** Why Revert is off, said beside it: "Changed again since". */
  revertBlocked?: string | null
  reverting?: boolean
  /** A line under the actions, such as what Revert did. */
  status?: ReactNode
  /** The change a link opened: a 1px accent-line border. */
  active?: boolean
  size?: Size
  className?: string
} & Omit<ComponentProps<"article">, "children">

const DELETED_ACCOUNT = "Deleted account"

/** The file line's words after the path. */
function actionWords(action: AgentChangeAction, movedFrom?: string): string {
  switch (action) {
    case "created":
      return "created"
    case "deleted":
      return "deleted"
    case "moved":
      return movedFrom ? `moved from ${movedFrom}` : "moved"
    default:
      return "changed"
  }
}

/**
 * One change an agent saved: the agent named for its person (Claude for Ada)
 * with the bot figure and when, New while it is new to the person, the file
 * and what happened to it, the thread it answered, then Show changes (the
 * diff, folded) and the actions, Open and Revert. Radius 12 and the panel
 * border like a comment thread; 15px text and 40px targets at `touch`.
 */
export function AgentChangeRow({
  agent,
  person,
  path,
  kind,
  action,
  movedFrom,
  version,
  when,
  now,
  isNew = false,
  thread,
  children,
  expanded,
  onExpandedChange,
  onOpen,
  onRevert,
  revertBlocked,
  reverting = false,
  status,
  active = false,
  size = "default",
  className,
  ...props
}: AgentChangeRowProps) {
  const touch = size === "touch"
  const name = agent || "An agent"
  const who = person ?? DELETED_ACCOUNT
  const date = new Date(when)
  const button = touch ? "touch" : "sm"
  return (
    <article
      aria-label={`${name} for ${who}: ${path} ${actionWords(action, movedFrom)}`}
      data-slot="agent-change"
      data-active={active || undefined}
      tabIndex={-1}
      className={cn(
        "flex min-w-0 flex-col rounded-menu border border-border bg-panel outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        touch ? "gap-3 p-3.5" : "gap-2.5 p-3",
        active && "border-accent-line",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar aria-hidden="true" className={cn("after:hidden", touch ? "size-8" : "size-6")}>
          <AvatarFallback>
            <Bot className="size-3.5" />
          </AvatarFallback>
        </Avatar>
        <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-[normal]", touch ? "text-[15px]" : "text-[13px]")}>
          <span className="min-w-0 truncate font-semibold text-foreground">{name}</span>
          <span className={cn("min-w-0 truncate text-muted-foreground", touch ? "text-[14px]" : "text-xs")}>for {who}</span>
          {isNew && <Badge>New</Badge>}
        </div>
        <time dateTime={date.toISOString()} title={absoluteTime(date)} className={cn("shrink-0 whitespace-nowrap text-dim", touch ? "text-[13px]" : "text-xs")}>
          {relativeTime(date, now)}
        </time>
      </div>
      <p className={cn("m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 leading-normal", touch ? "text-[15px]" : "text-[13px]")}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <KindBadge kind={kind} size={touch ? "touch" : "default"} />
          <span className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{path}</span>
        </span>
        <span className="text-muted-foreground">
          {actionWords(action, movedFrom)}, version {version}
        </span>
      </p>
      {thread && (
        <p className={cn("m-0 flex min-w-0 items-start gap-1.5 text-muted-foreground", touch ? "text-[14px]" : "text-xs")}>
          <MessageSquare aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {thread.onShow ? (
            <Button variant="inline" size="inline" className="min-w-0 text-left whitespace-normal [overflow-wrap:anywhere]" onClick={thread.onShow}>
              Answered {thread.opening ? `“${thread.opening}”` : "a comment"}
            </Button>
          ) : (
            <span className="min-w-0 [overflow-wrap:anywhere]">Answered {thread.opening ? `“${thread.opening}”` : "a comment"}</span>
          )}
        </p>
      )}
      {children !== undefined && (
        <Collapsible open={expanded} onOpenChange={(open) => onExpandedChange?.(open)} className="flex min-w-0 flex-col gap-2">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size={touch ? "touch" : "xs"}
                className={cn(
                  "justify-start self-start px-1 text-muted-foreground hover:text-foreground [&[data-panel-open]>svg]:rotate-90 [&>svg]:transition-transform motion-reduce:[&>svg]:transition-none",
                  touch ? "-ml-1 px-1.5" : "pointer-coarse:h-10",
                )}
              />
            }
          >
            <ChevronRight aria-hidden="true" />
            {expanded ? "Hide changes" : "Show changes"}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex min-w-0 flex-col gap-2">{children}</CollapsibleContent>
        </Collapsible>
      )}
      {(onOpen || onRevert) && (
        <div className="flex flex-wrap items-center gap-2">
          {onOpen && (
            <Button variant="secondary" size={button} onClick={onOpen}>
              <SquareArrowOutUpRight data-icon="inline-start" aria-hidden="true" />
              Open
            </Button>
          )}
          {onRevert && (
            <Button variant="outline" size={button} disabled={Boolean(revertBlocked) || reverting} onClick={onRevert}>
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              {reverting ? "Reverting…" : "Revert"}
            </Button>
          )}
          {onRevert && revertBlocked && <span className={cn("text-dim", touch ? "text-[13px]" : "text-xs")}>{revertBlocked}</span>}
        </div>
      )}
      {status && (
        <p role="status" className={cn("m-0 flex items-start gap-1.5 text-muted-foreground", touch ? "text-[14px]" : "text-xs")}>
          <FilePen aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {status}
        </p>
      )}
    </article>
  )
}
