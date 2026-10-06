// The chat card as it looks: the MCP Apps view of show_file, built from the
// component library, in every state (cardState.ts). ChatCard.tsx runs it in
// the host; the style guide shows it with fixed states. The card is its own
// bundle (scripts/build-chat-card.ts), so it imports the library's
// components from their files rather than the public entry, which would
// bundle the whole style guide.
import "./card.css"
import { CircleAlert, ExternalLink, Info, Pencil, TriangleAlert } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { DottedPage } from "@/components/panel"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Banner, BannerAction, Callout } from "@/features/design-system/ui/Banner"
import { KindBadge } from "@/features/design-system/ui/KindBadge"
import { NoteProse } from "@/features/design-system/ui/NoteProse"
import { StatusDot } from "@/features/design-system/ui/StatusDot"
import { cn } from "@/lib/utils"
import { badgeKind, CARD_NOTE_CLASS, EmbedArt, EmbedFigure } from "./cardNote"
import type { CardState } from "./cardState"
import { EMBED_NOTES, FILE_NOTES, svgFor, type CardEmbed, type CardFile } from "./toolResult"

export { CARD_NOTE_CLASS, EmbedFigure } from "./cardNote"

/**
 * The preview of a note's components, or of a component file, in its own
 * sandboxed frame (preview/ComponentPreview.tsx). The frame stays mounted
 * while it loads, so the card can show it once it has drawn.
 */
export type CardPreview = {
  frame: ReactNode
  /** "asking": custom code from a shared project waits for Run code before it runs. */
  status: "loading" | "shown" | "failed" | "asking"
  /** Why the preview failed. */
  message: string | null
  /** While asking: the files whose code would run, by path. */
  files?: readonly string[]
  /** Runs the shared project's custom component code. */
  onRun?: () => void
  /**
   * A link clicked in the preview, which opens only when the person says so
   * here: the preview's code could ask for any link at any time.
   */
  link?: {
    url: string
    /** Where in the preview the link is: the prompt shows beside it. Without one, it follows the preview. */
    spot?: { y: number; side: "below" | "above" } | null
    onOpen: () => void
    onDismiss: () => void
  } | null
}

export const PREVIEW_TEXT = {
  noteFailed: (message: string | null) => `The components in this note could not be shown here${message ? `: ${message}` : "."}`,
  componentFailed: (message: string | null) => `This component could not be shown${message ? `: ${message}` : "."}`,
  asking: (kind: CardFile["kind"]) =>
    kind === "note" ? "This note from a shared project runs custom code." : "These components are in a shared project and run custom code.",
  askingFiles: "The code comes from:",
  isolated: "It runs in an isolated frame, with no network and no access to your account.",
  openLink: (url: string) => `Open ${url}?`,
}

export type CardViewProps = Omit<ComponentProps<"section">, "children"> & {
  state: CardState
  /** Whether the host lets the card save, so a note can be edited here. */
  canEdit: boolean
  /** Why a note cannot be edited here, where it otherwise could: the footer says it in place of Edit. */
  editNote?: string | null
  /** The note editor, shown while editing and in a conflict. */
  editor?: ReactNode
  /** A new file as it is written, while the card is live. */
  live?: ReactNode
  /** The components' preview: a note's in place of its HTML once drawn, or a component file's. */
  preview?: CardPreview | null
  onEdit?: () => void
  onSave?: () => void
  onCancel?: () => void
  onReload?: () => void
}

/**
 * The card: the file's kind, name, path and version with a link to open it
 * in elaborat.ing; the note as the app renders it (or the drawing on the
 * dotted canvas); problems in banners; and Edit, Save, Load latest and
 * Cancel with the save status under it.
 */
export function CardView({ state, canEdit, editNote = null, editor, live, preview = null, onEdit, onSave, onCancel, onReload, className, ...props }: CardViewProps) {
  const shown = state.phase === "shown" ? state : null
  return (
    <section
      data-slot="chat-card"
      aria-busy={state.phase === "loading" || state.phase === "live" || undefined}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel text-foreground", className)}
      {...props}
    >
      <CardHeader state={state} />
      <CardBody state={state} editor={editor} live={live} preview={preview} />
      {shown?.banner && (
        <div className="px-4 pb-3 max-[500px]:px-3">
          <Banner tone={shown.banner.tone}>{shown.banner.text}</Banner>
        </div>
      )}
      {shown && <CardFooter state={shown} canEdit={canEdit} editNote={editNote} onEdit={onEdit} onSave={onSave} onCancel={onCancel} onReload={onReload} />}
      {state.phase === "live" && (
        <footer className="border-t border-border px-4 py-3 max-[500px]:px-3">
          <p role="status" className="truncate text-[13px] leading-snug text-muted-foreground">
            {state.kind === "drawing" ? "Drawing" : "Writing"} {state.path}
          </p>
        </footer>
      )}
    </section>
  )
}

/** The file's kind letter, name and path, its version, and Open in elaborat.ing. */
function CardHeader({ state }: { state: CardState }) {
  const file = state.phase === "shown" ? state.file : null
  const path = file?.path ?? (state.phase === "loading" || state.phase === "live" ? state.path : null)
  const name = state.phase === "problem" ? "This file could not be shown" : path ? path.split("/").pop() || path : "Loading file"
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 max-[500px]:px-3">
      <div className="flex min-w-0 flex-1 basis-[200px] items-start gap-2">
        {path && <KindBadge kind={badgeKind(file?.kind ?? (state.phase === "live" ? state.kind : "file"))} className="leading-5" />}
        <div className="min-w-0">
          <p className="truncate text-sm leading-5 font-semibold">{name}</p>
          {path && <p className="truncate font-mono text-xs leading-[18px] text-dim">{path}</p>}
        </div>
      </div>
      {file && file.version !== null && !file.preview?.draft && <span className="font-mono text-xs text-dim">v{file.version}</span>}
      {file?.preview?.draft && <span className="font-mono text-xs text-dim">draft</span>}
      {file?.url && (
        <a href={file.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          {/* A draft is no file yet: the link opens its project. */}
          {file.preview?.draft ? "Open the project in elaborat.ing" : "Open in elaborat.ing"}
          <ExternalLink aria-hidden="true" data-icon="inline-end" />
        </a>
      )}
    </header>
  )
}

/**
 * Asks before a preview runs custom code from a shared project: the files it
 * comes from and who last changed them (where the server says), where it
 * runs, and Run code. `column`: in a note's 680 column.
 */
function AskingBanner({ file, preview, column = false }: { file: CardFile; preview: CardPreview; column?: boolean }) {
  return (
    <div className={column ? "px-6 pt-4 max-[500px]:px-4" : "p-4 max-[500px]:p-3"}>
      <Banner tone="info" className={cn(column && "mx-auto max-w-[680px]")}>
        <p>
          {PREVIEW_TEXT.asking(file.kind)} {PREVIEW_TEXT.askingFiles}
        </p>
        <ul aria-label="Files with custom code" className="my-1.5 flex flex-col gap-0.5">
          {(preview.files ?? []).map((path) => (
            <li key={path} className="wrap-anywhere">
              <span className="font-mono text-xs">{path}</span>
              {file.kind === "note" && path === file.path ? " (this note)" : ""}
              {file.editors[path] ? `, last changed by ${file.editors[path]}` : ""}
            </li>
          ))}
        </ul>
        <p>
          {PREVIEW_TEXT.isolated} <BannerAction onClick={preview.onRun}>Run code</BannerAction>
        </p>
      </Banner>
    </div>
  )
}

/** Three lines of text on their way. */
export function LoadingLines() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5 px-6 py-5 max-[500px]:px-4">
      <Skeleton className="h-2.5 rounded-pill" />
      <Skeleton className="h-2.5 w-4/5 rounded-pill" />
      <Skeleton className="h-2.5 w-[55%] rounded-pill" />
    </div>
  )
}

/**
 * Where the preview's frame lives: in the card's flow once it has drawn,
 * and until then kept out of sight (laid out at the card's width, so it can
 * measure itself) and out of the keyboard's way. `column`: a note's, whose
 * text is in a 680 column the link prompt keeps to.
 */
function PreviewSlot({ preview, column = false }: { preview: CardPreview; column?: boolean }) {
  const shown = preview.status === "shown"
  const link = shown ? preview.link : null
  const prompt = link && (
    <Banner
      tone="info"
      className={cn(link.spot && "shadow-[0_8px_24px_var(--shadow)]", column && "mx-auto max-w-[680px]")}
      action={
        <>
          <BannerAction onClick={link.onOpen}>Open</BannerAction> <BannerAction onClick={link.onDismiss}>Not now</BannerAction>
        </>
      }
    >
      <span className="break-all">{PREVIEW_TEXT.openLink(link.url)}</span>
    </Banner>
  )
  return (
    <>
      <div data-preview={preview.status} aria-hidden={!shown || undefined} className={cn("relative", !shown && "invisible h-0 overflow-hidden")}>
        {preview.frame}
        {/* Beside the link, so a link far up a long note is not asked about out of sight. */}
        {link?.spot && (
          <div
            data-slot="link-prompt"
            className={cn(
              "absolute z-10",
              column ? "inset-x-6 max-[500px]:inset-x-4" : "inset-x-4 max-[500px]:inset-x-3",
              link.spot.side === "above" ? "-translate-y-full pb-1" : "pt-1",
            )}
            style={{ top: link.spot.y }}
          >
            {prompt}
          </div>
        )}
      </div>
      {link && !link.spot && (
        <div data-slot="link-prompt" className={column ? "px-6 pb-4 max-[500px]:px-4" : "px-4 pb-3 max-[500px]:px-3"}>
          {prompt}
        </div>
      )}
    </>
  )
}

function CardBody({ state, editor, live, preview }: { state: CardState; editor?: ReactNode; live?: ReactNode; preview: CardPreview | null }) {
  if (state.phase === "loading") return <LoadingLines />
  if (state.phase === "live") return live ?? <LoadingLines />
  if (state.phase === "problem") {
    return (
      <div className="p-4 max-[500px]:p-3">
        <Banner tone={state.tone}>{state.message}</Banner>
      </div>
    )
  }
  const { file, mode } = state
  if (file.kind === "note" && file.html !== null) {
    if (mode !== "read") {
      return (
        <div className="flex flex-col gap-2 px-4 pt-4 pb-3 max-[500px]:px-3">
          {editor}
          <p className="text-[13px] leading-snug text-muted-foreground">Embeds and other MDX stay as they are.</p>
        </div>
      )
    }
    // A note with components shows the server's HTML until their preview has drawn, and again if it fails.
    return (
      <>
        {preview?.status === "asking" && <AskingBanner file={file} preview={preview} column />}
        {preview?.status !== "shown" && <NoteHtml html={file.html} embeds={file.embeds} svgs={file.svgs} />}
        {preview && preview.status !== "failed" && <PreviewSlot preview={preview} column />}
        {preview?.status === "failed" && (
          // In the note's column, under its text.
          <div className="px-6 pb-4 max-[500px]:px-4">
            <Banner tone="warn" className="mx-auto max-w-[680px]">
              {PREVIEW_TEXT.noteFailed(preview.message)}
            </Banner>
          </div>
        )}
        {file.truncated && <p className="px-6 pb-4 text-[13px] leading-snug text-muted-foreground max-[500px]:px-4">Open in elaborat.ing to read the rest.</p>}
      </>
    )
  }
  if (file.kind === "component") {
    return (
      <>
        {preview?.status === "asking" && <AskingBanner file={file} preview={preview} />}
        {preview?.status !== "shown" && preview?.status !== "failed" && preview?.status !== "asking" && <LoadingLines />}
        {preview && preview.status !== "failed" && <PreviewSlot preview={preview} />}
        {preview?.status === "failed" && (
          <div className="p-4 max-[500px]:p-3">
            <Banner tone="danger">{PREVIEW_TEXT.componentFailed(preview.message)}</Banner>
          </div>
        )}
        {!preview && <p className="px-4 py-4 text-[13px] leading-snug text-muted-foreground">{FILE_NOTES.component}</p>}
      </>
    )
  }
  const drawn = (file.kind === "drawing" || file.kind === "diagram") && file.embeds[0] ? file.embeds[0] : null
  if (drawn) return <DrawingBody embed={drawn} svgs={file.svgs} />
  return <p className="px-4 py-4 text-[13px] leading-snug text-muted-foreground">{file.kind === "note" ? FILE_NOTES.file : FILE_NOTES[file.kind]}</p>
}

/** The note editor's frame: the note's type in an accent border, so editing reads as editing. */
export function EditorFrame({ children }: { children: ReactNode }) {
  return (
    <div className="card-editor rounded-tile border border-primary">
      <NoteProse className={cn(CARD_NOTE_CLASS, "max-[500px]:px-3")}>{children}</NoteProse>
    </div>
  )
}

type Slot = { host: HTMLElement; node: ReactNode }

/**
 * The server's sanitized HTML for a note, parsed once, with each embed's
 * figure and each callout replaced by a slot the library's components render
 * into. Only the server's own markup is read: a figure's data-embed index
 * and a callout's tone.
 */
function prepareNote(html: string, embeds: CardFile["embeds"], svgs: Record<string, string>) {
  const holder = document.createElement("div")
  holder.innerHTML = html
  const slots: Slot[] = []
  for (const figure of holder.querySelectorAll<HTMLElement>("figure[data-embed]")) {
    const embed = embeds[Number(figure.dataset.embed)]
    if (!embed) {
      figure.remove()
      continue
    }
    const host = document.createElement("div")
    host.className = "min-w-0"
    figure.replaceWith(host)
    slots.push({ host, node: <EmbedFigure embed={embed} svgs={svgs} /> })
  }
  for (const aside of holder.querySelectorAll<HTMLElement>("aside.callout")) {
    const host = document.createElement("div")
    const tone = aside.dataset.tone === "warn" || aside.dataset.tone === "error" ? aside.dataset.tone : "info"
    const content = aside.innerHTML
    aside.replaceWith(host)
    slots.push({ host, node: <NoteCallout tone={tone} html={content} /> })
  }
  return { nodes: [...holder.childNodes], slots }
}

/** A rendered note from the server's HTML, with its drawings and callouts from the library. */
export function NoteHtml({ html, embeds, svgs }: { html: string; embeds: CardFile["embeds"]; svgs: Record<string, string> }) {
  const container = useRef<HTMLDivElement>(null)
  const prepared = useMemo(() => prepareNote(html, embeds, svgs), [html, embeds, svgs])
  useLayoutEffect(() => {
    container.current?.replaceChildren(...prepared.nodes)
  }, [prepared])
  return (
    <NoteProse className={CARD_NOTE_CLASS}>
      <div ref={container} className="contents" />
      {prepared.slots.map((slot, index) => createPortal(slot.node, slot.host, String(index)))}
    </NoteProse>
  )
}

const CALLOUT_TONES = {
  info: { icon: Info, className: undefined },
  warn: { icon: TriangleAlert, className: "bg-warn-bg text-warn-text" },
  error: { icon: CircleAlert, className: "bg-[color-mix(in_oklab,var(--danger)_10%,var(--panel))] text-destructive" },
} as const

/** A note's callout as the rendered note draws it: the library's callout in the tone's colours, with its icon (not on a phone). */
function NoteCallout({ tone, html }: { tone: keyof typeof CALLOUT_TONES; html: string }) {
  const { icon: Icon, className } = CALLOUT_TONES[tone]
  return (
    <Callout data-tone={tone} className={className} icon={<Icon aria-hidden="true" className="max-[500px]:hidden" />}>
      <div className="card-callout" dangerouslySetInnerHTML={{ __html: html }} />
    </Callout>
  )
}

/** A drawing or diagram on its own: the picture on the dotted canvas, and a banner when it is out of date. */
function DrawingBody({ embed, svgs }: { embed: CardEmbed; svgs: Record<string, string> }) {
  const svg = svgFor(embed, svgs)
  return (
    <>
      <DottedPage className="flex min-h-[200px] items-center justify-center p-6 max-[500px]:min-h-[160px] max-[500px]:p-4">
        {svg ? (
          <EmbedArt svg={svg} embed={embed} whole />
        ) : (
          <p className="text-center text-[13px] leading-snug text-muted-foreground">{EMBED_NOTES[embed.status]}</p>
        )}
      </DottedPage>
      {svg && embed.status === "stale" && (
        <div className="border-t border-border px-4 py-3 max-[500px]:px-3">
          <Banner tone="warn">{EMBED_NOTES.stale}</Banner>
        </div>
      )}
    </>
  )
}

/** Edit, Save, Load latest and Cancel for the mode, and the save status. */
function CardFooter({
  state,
  canEdit,
  editNote,
  onEdit,
  onSave,
  onCancel,
  onReload,
}: Pick<CardViewProps, "canEdit" | "editNote" | "onEdit" | "onSave" | "onCancel" | "onReload"> & { state: Extract<CardState, { phase: "shown" }> }) {
  const { mode, busy, dirty, status, file } = state
  const editable = canEdit && file.source !== null
  const note = mode === "read" && !editable && file.source !== null ? editNote : null
  const statusText =
    status.kind === "saving" ? (
      <StatusDot status="unsaved">Saving</StatusDot>
    ) : status.kind === "saved" ? (
      <StatusDot status="synced">Saved as v{status.version}.</StatusDot>
    ) : mode === "edit" && dirty ? (
      <StatusDot status="unsaved" />
    ) : null
  if (mode === "read" && !editable && !statusText && !note) return null
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 max-[500px]:px-3">
      {note && <p className="text-[13px] leading-snug text-muted-foreground">{note}</p>}
      {mode === "read" && editable && (
        <Button variant="secondary" disabled={busy} onClick={onEdit}>
          <Pencil aria-hidden="true" data-icon="inline-start" />
          Edit
        </Button>
      )}
      {mode === "edit" && (
        <Button disabled={busy || !dirty} onClick={onSave}>
          Save
        </Button>
      )}
      {mode === "conflict" && (
        <Button disabled={busy} onClick={onReload}>
          Load latest
        </Button>
      )}
      {mode !== "read" && (
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
      <span role="status" className="ml-auto text-[13px] leading-snug text-muted-foreground">
        {statusText}
      </span>
    </footer>
  )
}
