import { ArrowUp, Check, CircleAlert, LoaderCircle, SquarePen, Sparkles, Square, Undo2, X } from "lucide-react"
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { ChatGPTButton } from "./ChatGPTButton"
import { ChatGPTMark } from "./ChatGPTMark"
import { EmptyState } from "./EmptyState"
import { FloatingPanel, type FloatingPanelProps } from "./FloatingPanel"
import { IconButton } from "./IconButton"
import { LoadingLine } from "./LoadingLine"
import { PanelMessage } from "./PanelMessage"

// The assistant: a chat that edits the project's files on the person's
// ChatGPT plan. As the comments do, it is a floating panel beside the file on
// a desktop and a sheet from the bottom on a phone, with the same body: the
// messages and the steps the assistant takes, then the composer with the
// model picker, "Using ChatGPT plan" and Manage usage. Or one of its states:
// loading, not connected, needs Plus or Pro, reconnect; and at the foot of
// the messages, usage limit, unavailable and error. Built from the library's
// FloatingPanel and EmptyState and shadcn's Sheet, Select, Textarea, Button.

/** Where people manage what apps use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage"

export type AssistantStatus = "loading" | "ready" | "not-connected" | "not-eligible" | "limit" | "unavailable" | "reconnect" | "error"

/** A message, a step the assistant takes ("Reading notes/plan.mdx"), or a note from the app. */
export type AssistantEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "step"; text: string; path?: string; state: "running" | "done" | "kept" | "error" }
  | { id: string; kind: "note"; text: string }

export type AssistantModel = { slug: string; name: string }

export type AssistantBodyProps = {
  status: AssistantStatus
  entries: readonly AssistantEntry[]
  /** A turn is running: the composer offers Stop. */
  running?: boolean
  /** More about an error, under its title. */
  message?: string
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop?: () => void
  models: readonly AssistantModel[]
  model: string | null
  onModelChange: (slug: string) => void
  /** Starts Sign in with ChatGPT, from not connected and reconnect. */
  onConnect?: () => void
  /** Sign-in is starting: the button waits. */
  connecting?: boolean
  /** Not connected because the person did not allow plan use before: says so. */
  planOff?: boolean
  onRetry?: () => void
  /** Why the assistant can't write here, such as a read-only project; the composer says so. */
  readOnly?: string | null
  /** What just happened, read out politely ("Wrote art/flow.excalidraw"). */
  announcement?: string
  size?: "default" | "touch"
}

const STEP_ICONS = {
  running: <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />,
  done: <Check aria-hidden="true" className="size-3.5" />,
  kept: <Undo2 aria-hidden="true" className="size-3.5" />,
  error: <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />,
}

/** One step: the verb, then the file's path in code type. */
function StepRow({ entry, touch }: { entry: Extract<AssistantEntry, { kind: "step" }>; touch: boolean }) {
  return (
    <div data-slot="assistant-step" data-state={entry.state} className={cn("flex min-w-0 items-center gap-2 text-muted-foreground", touch ? "text-[14px]" : "text-[12.5px]")}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-row bg-seg">{STEP_ICONS[entry.state]}</span>
      <span className="min-w-0 truncate">
        {entry.text}
        {entry.path && (
          <>
            {" "}
            <span className="font-mono text-foreground">{entry.path}</span>
          </>
        )}
      </span>
    </div>
  )
}

function Entries({ entries, touch }: { entries: readonly AssistantEntry[]; touch: boolean }) {
  return (
    <ol aria-label="Messages" className={cn("flex flex-col", touch ? "gap-3.5" : "gap-3")}>
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0">
          {entry.kind === "user" ? (
            <p className={cn("ml-auto w-fit max-w-[85%] rounded-menu bg-seg px-3 py-2 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]", touch ? "text-[15px]" : "text-[13px]")}>
              <span className="sr-only">You: </span>
              {entry.text}
            </p>
          ) : entry.kind === "assistant" ? (
            <p className={cn("whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]", touch ? "text-[15px] leading-relaxed" : "text-[13px] leading-relaxed")}>
              <span className="sr-only">Assistant: </span>
              {entry.text}
            </p>
          ) : entry.kind === "step" ? (
            <StepRow entry={entry} touch={touch} />
          ) : (
            <PanelMessage size={touch ? "touch" : "default"}>{entry.text}</PanelMessage>
          )}
        </li>
      ))}
    </ol>
  )
}

/** A compact card at the foot of the messages: the limit (with the ChatGPT mark), unavailable, or an error. */
function StatusCard({ status, message, onRetry, touch }: { status: AssistantStatus; message?: string; onRetry?: () => void; touch: boolean }) {
  const size = touch ? "touch" : "default"
  if (status === "limit")
    return (
      <div data-slot="assistant-limit" className="flex flex-col gap-2.5 rounded-menu border border-border bg-panel p-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <ChatGPTMark className="size-4" />
          ChatGPT
        </span>
        <p className={cn("font-semibold", touch ? "text-[16px]" : "text-sm")}>Usage limit reached</p>
        <p className={cn("text-muted-foreground", touch ? "text-[14px]" : "text-[13px]")}>
          You have reached a limit on your ChatGPT plan or on this app. Review it in ChatGPT settings.
        </p>
        <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className={buttonVariants({ size, className: "self-start" })}>
          Manage usage
        </a>
      </div>
    )
  if (status !== "unavailable" && status !== "error") return null
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-menu border border-border bg-panel p-3">
      <p className={cn("flex items-center gap-1.5 font-semibold", touch ? "text-[16px]" : "text-sm")}>
        <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        {status === "unavailable" ? "ChatGPT plan usage is unavailable right now" : "Something went wrong"}
      </p>
      <p className={cn("text-muted-foreground", touch ? "text-[14px]" : "text-[13px]")}>{message ?? "Try again in a little while."}</p>
      {onRetry && (
        <Button variant="secondary" size={size} className="self-start" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** The states that take the whole body: nothing to chat with yet. */
function StateBlock({ status, planOff, onConnect, connecting, touch }: Pick<AssistantBodyProps, "status" | "planOff" | "onConnect" | "connecting"> & { touch: boolean }) {
  if (status === "loading")
    return (
      <div className="flex flex-col gap-3 p-3">
        <PanelMessage role="status" size={touch ? "touch" : "default"}>
          Checking your ChatGPT connection…
        </PanelMessage>
      </div>
    )
  const connect = onConnect && <ChatGPTButton onClick={onConnect} disabled={connecting} />
  if (status === "not-connected")
    return (
      <EmptyState
        icon={<ChatGPTMark />}
        title="Use your ChatGPT plan"
        description={
          planOff
            ? "Allow elaborat.ing to use your ChatGPT plan, and the assistant can write here."
            : "The assistant writes notes, drawings and diagrams in this project with your ChatGPT plan. You save or discard each change."
        }
        actions={connect}
        className="py-10"
      />
    )
  if (status === "reconnect")
    return <EmptyState icon={<ChatGPTMark />} title="Reconnect ChatGPT" description="Your ChatGPT connection stopped working. Connect again to continue." actions={connect} className="py-10" />
  if (status === "not-eligible")
    return (
      <EmptyState
        icon={<CircleAlert />}
        title="Needs ChatGPT Plus or Pro"
        description="Using your ChatGPT plan in elaborat.ing needs a Plus or Pro plan."
        actions={
          <a href="https://help.openai.com" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: touch ? "touch" : "default" })}>
            Learn more
          </a>
        }
        className="py-10"
      />
    )
  return null
}

/** "Using ChatGPT plan" with the mark, and Manage usage, under the composer. */
export function ChatGPTPlanLabel({ size = "default", className }: { size?: "default" | "touch"; className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-muted-foreground", size === "touch" ? "text-[13px]" : "text-xs", className)}>
      <ChatGPTMark className="size-3.5 shrink-0" />
      <span>Using ChatGPT plan</span>
      <span aria-hidden="true">·</span>
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="font-semibold text-foreground underline-offset-2 hover:underline">
        Manage usage
      </a>
    </p>
  )
}

function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  running,
  models,
  model,
  onModelChange,
  disabledReason,
  touch,
}: Pick<AssistantBodyProps, "draft" | "onDraftChange" | "onSend" | "onStop" | "running" | "models" | "model" | "onModelChange"> & {
  disabledReason: string | null
  touch: boolean
}) {
  const modelId = useId()
  const canSend = !running && !disabledReason && draft.trim() !== "" && model !== null
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSend) onSend()
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) onSend()
      }}
    >
      <Textarea
        aria-label="Message the assistant"
        placeholder={disabledReason ?? "Ask for a note, a drawing or a diagram"}
        value={draft}
        disabled={Boolean(disabledReason)}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn("max-h-40 min-h-[60px] resize-none", touch && "text-[15px]")}
      />
      <div className="flex items-center gap-2">
        <label htmlFor={modelId} className="sr-only">
          Model
        </label>
        <Select
          items={models.map((entry) => ({ value: entry.slug, label: entry.name }))}
          value={model}
          onValueChange={(value) => {
            if (typeof value === "string") onModelChange(value)
          }}
        >
          <SelectTrigger id={modelId} size="sm" className="max-w-[60%] min-w-0">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((entry) => (
              <SelectItem key={entry.slug} value={entry.slug}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto" />
        {running ? (
          <Button type="button" variant="secondary" size={touch ? "icon-lg" : "icon"} aria-label="Stop" onClick={onStop}>
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button type="submit" size={touch ? "icon-lg" : "icon"} aria-label="Send" disabled={!canSend}>
            <ArrowUp />
          </Button>
        )}
      </div>
    </form>
  )
}

function AssistantBody({
  status,
  entries,
  running = false,
  message,
  draft,
  onDraftChange,
  onSend,
  onStop,
  models,
  model,
  onModelChange,
  onConnect,
  connecting,
  planOff,
  onRetry,
  readOnly,
  announcement,
  size = "default",
}: AssistantBodyProps) {
  const touch = size === "touch"
  const end = useRef<HTMLDivElement>(null)
  const last = entries.at(-1)
  // The newest message stays in view as it is written.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [entries.length, last?.text, status])
  const block = status === "loading" || status === "not-connected" || status === "reconnect" || status === "not-eligible"
  const disabledReason = status === "limit" ? "Usage limit reached" : (readOnly ?? null)
  return (
    <>
      {status === "loading" && <LoadingLine label="Checking your ChatGPT connection" className="shrink-0" />}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ScrollArea className="min-h-0 flex-1">
        <div data-slot="assistant-body" className={cn("flex flex-col", touch ? "gap-4 p-3 pb-6" : "gap-3 p-3")}>
          {block ? (
            <StateBlock status={status} planOff={planOff} onConnect={onConnect} connecting={connecting} touch={touch} />
          ) : (
            <>
              {entries.length === 0 && (
                <PanelMessage size={touch ? "touch" : "default"}>
                  Ask for a note, a drawing or a diagram. The assistant reads this project and shows its changes in the file, for you to save or discard.
                </PanelMessage>
              )}
              <Entries entries={entries} touch={touch} />
              <StatusCard status={status} message={message} onRetry={onRetry} touch={touch} />
            </>
          )}
          <div ref={end} />
        </div>
      </ScrollArea>
      {!block && (
        <div className={cn("flex shrink-0 flex-col gap-2 border-t border-border", touch ? "px-3 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]" : "p-3")}>
          <Composer
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={onSend}
            onStop={onStop}
            running={running}
            models={models}
            model={model}
            onModelChange={onModelChange}
            disabledReason={disabledReason}
            touch={touch}
          />
          <ChatGPTPlanLabel size={size} />
        </div>
      )}
    </>
  )
}

function Header({ title, onNewChat, close, touch }: { title: ReactNode; onNewChat?: () => void; close?: ReactNode; touch: boolean }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2 border-b border-border", touch ? "h-14 pr-2.5 pl-4" : "h-12 pr-2 pl-3.5")}>
      <Sparkles aria-hidden="true" className={cn("shrink-0 text-muted-foreground", touch ? "size-5" : "size-4")} />
      {title}
      <span className="ml-auto flex items-center gap-0.5">
        {onNewChat && (
          <IconButton label="New chat" onClick={onNewChat} className={cn(touch && "size-10 [&_svg]:size-5")}>
            <SquarePen />
          </IconButton>
        )}
        {close}
      </span>
    </div>
  )
}

export type AssistantPanelProps = AssistantBodyProps &
  Omit<FloatingPanelProps, "children" | "title"> & {
    /** The title's element, to fit the page's heading levels. */
    headingLevel?: 2 | 3 | 4
    onNewChat?: () => void
    onClose?: () => void
  }

/**
 * The desktop panel: a FloatingPanel 360 wide (in the comments' place,
 * beside the file), as tall as its place gives it. The header (48 high): the
 * assistant's icon, "Assistant" at 14/600, New chat and Close. Render it as
 * an <aside> (`render`) where it sits beside the file.
 */
export function AssistantPanel({ headingLevel = 2, onNewChat, onClose, className, status, entries, running, message, draft, onDraftChange, onSend, onStop, models, model, onModelChange, onConnect, connecting, planOff, onRetry, readOnly, announcement, ...props }: AssistantPanelProps) {
  const Heading = `h${headingLevel}` as const
  return (
    <FloatingPanel data-slot="assistant-panel" className={cn("flex w-[360px] max-w-full flex-col overflow-hidden", className)} {...props}>
      <Header
        touch={false}
        title={<Heading className="text-sm leading-none font-semibold">Assistant</Heading>}
        onNewChat={onNewChat}
        close={
          onClose && (
            <IconButton label="Close assistant" onClick={onClose}>
              <X />
            </IconButton>
          )
        }
      />
      <AssistantBody {...{ status, entries, running, message, draft, onDraftChange, onSend, onStop, models, model, onModelChange, onConnect, connecting, planOff, onRetry, readOnly, announcement }} />
    </FloatingPanel>
  )
}

export type AssistantSheetProps = Omit<AssistantBodyProps, "size"> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNewChat?: () => void
  /** Where the sheet renders: the body by default (a style guide sample passes its phone frame). */
  container?: HTMLElement | null
  modal?: boolean
  className?: string
  overlayClassName?: string
  /** A picture of the sheet (the style guide's): no dialog role, nothing to reach. */
  inert?: boolean
}

/**
 * The phone's assistant: shadcn's Sheet from the bottom, 75% of the screen
 * high, radius 14 at the top with a grab bar, as the comments' sheet. The
 * same body at the touch size: 15px text, 40px targets, a 56 high header
 * with New chat and a 40px Close.
 */
export function AssistantSheet({ open, onOpenChange, onNewChat, container, modal, className, overlayClassName, inert, ...body }: AssistantSheetProps) {
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
        overlayClassName={cn("supports-backdrop-filter:backdrop-blur-none", overlayClassName)}
        className={cn("gap-0 overflow-hidden rounded-t-panel border-x border-border p-0 shadow-panel data-[side=bottom]:h-[75svh]", className)}
      >
        <div aria-hidden="true" className="flex shrink-0 justify-center pt-2">
          <span className="h-1 w-9 rounded-pill bg-border" />
        </div>
        <Header
          touch
          title={<SheetTitle className="text-[17px] leading-none font-semibold">Assistant</SheetTitle>}
          onNewChat={onNewChat}
          close={
            <SheetClose render={<Button ref={close} variant="ghost" size="icon-lg" aria-label="Close assistant" />}>
              <X aria-hidden="true" />
            </SheetClose>
          }
        />
        <SheetDescription className="sr-only">The assistant, on your ChatGPT plan.</SheetDescription>
        <AssistantBody {...body} size="touch" />
      </SheetContent>
    </Sheet>
  )
}
