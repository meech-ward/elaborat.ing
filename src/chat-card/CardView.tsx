// The chat card as it looks: the MCP Apps view of show_file, built from the
// component library, in every state (cardState.ts). ChatCard.tsx runs it in
// the host; the style guide shows it with fixed states. The card is its own
// bundle (scripts/build-chat-card.ts), so it imports the library's
// components from their files rather than the public entry, which would
// bundle the whole style guide.
import "./card.css"
import { CircleAlert, ExternalLink, Info, Pencil, TriangleAlert } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { DottedPage } from "@/components/panel"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Banner, Callout } from "@/features/design-system/ui/Banner"
import { EmbedBox } from "@/features/design-system/ui/EmbedBox"
import { KindBadge, type FileKind as BadgeKind } from "@/features/design-system/ui/KindBadge"
import { NoteProse } from "@/features/design-system/ui/NoteProse"
import { StatusDot } from "@/features/design-system/ui/StatusDot"
import { pictureSize } from "@/features/rendered/resourceViewer.ts"
import { cn } from "@/lib/utils"
import type { CardState } from "./cardState"
import { EMBED_NOTES, FILE_NOTES, KIND_NAMES, svgFor, type CardEmbed, type CardFile, type FileKind } from "./toolResult"

const badgeKind = (kind: FileKind): BadgeKind => (kind === "file" ? "text" : kind)

export type CardViewProps = Omit<ComponentProps<"section">, "children"> & {
  state: CardState
  /** Whether the host lets the card save, so a note can be edited here. */
  canEdit: boolean
  /** The note editor, shown while editing and in a conflict. */
  editor?: ReactNode
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
export function CardView({ state, canEdit, editor, onEdit, onSave, onCancel, onReload, className, ...props }: CardViewProps) {
  const shown = state.phase === "shown" ? state : null
  return (
    <section
      data-slot="chat-card"
      aria-busy={state.phase === "loading" || undefined}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel text-foreground", className)}
      {...props}
    >
      <CardHeader state={state} />
      <CardBody state={state} editor={editor} />
      {shown?.banner && (
        <div className="px-4 pb-3 max-[500px]:px-3">
          <Banner tone={shown.banner.tone}>{shown.banner.text}</Banner>
        </div>
      )}
      {shown && <CardFooter state={shown} canEdit={canEdit} onEdit={onEdit} onSave={onSave} onCancel={onCancel} onReload={onReload} />}
    </section>
  )
}

/** The file's kind letter, name and path, its version, and Open in elaborat.ing. */
function CardHeader({ state }: { state: CardState }) {
  const file = state.phase === "shown" ? state.file : null
  const path = file?.path ?? (state.phase === "loading" ? state.path : null)
  const name = state.phase === "problem" ? "This file could not be shown" : path ? path.split("/").pop() || path : "Loading file"
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 max-[500px]:px-3">
      <div className="flex min-w-0 flex-1 basis-[200px] items-start gap-2">
        {path && <KindBadge kind={badgeKind(file?.kind ?? "file")} className="leading-5" />}
        <div className="min-w-0">
          <p className="truncate text-sm leading-5 font-semibold">{name}</p>
          {path && <p className="truncate font-mono text-xs leading-[18px] text-dim">{path}</p>}
        </div>
      </div>
      {file && file.version !== null && <span className="font-mono text-xs text-dim">v{file.version}</span>}
      {file?.url && (
        <a href={file.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Open in elaborat.ing
          <ExternalLink aria-hidden="true" data-icon="inline-end" />
        </a>
      )}
    </header>
  )
}

function CardBody({ state, editor }: { state: CardState; editor?: ReactNode }) {
  if (state.phase === "loading") {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2.5 px-6 py-5 max-[500px]:px-4">
        <Skeleton className="h-2.5 rounded-pill" />
        <Skeleton className="h-2.5 w-4/5 rounded-pill" />
        <Skeleton className="h-2.5 w-[55%] rounded-pill" />
      </div>
    )
  }
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
    return (
      <>
        <NoteHtml html={file.html} embeds={file.embeds} svgs={file.svgs} />
        {file.truncated && <p className="px-6 pb-4 text-[13px] leading-snug text-muted-foreground max-[500px]:px-4">Open in elaborat.ing to read the rest.</p>}
      </>
    )
  }
  const drawn = (file.kind === "drawing" || file.kind === "diagram") && file.embeds[0] ? file.embeds[0] : null
  if (drawn) return <DrawingBody embed={drawn} svgs={file.svgs} />
  return <p className="px-4 py-4 text-[13px] leading-snug text-muted-foreground">{file.kind === "note" ? FILE_NOTES.file : FILE_NOTES[file.kind]}</p>
}

/** The note's type, as the app's rendered note: NoteProse, at the phone's sizes on a phone. */
export const CARD_NOTE_CLASS = cn(
  "card-note px-6 py-5 max-[500px]:px-4 max-[500px]:py-4",
  "max-[500px]:[&_h1]:text-[30px] max-[500px]:[&_li]:text-base max-[500px]:[&_li]:leading-[1.8] max-[500px]:[&_p]:text-base",
)

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

/**
 * The server's SVG of a drawing, which escapes everything it takes from the
 * file. It shows at a readable size (card.css): its own width and width to
 * height ratio set that. In a note, a picture cut off at the bottom is marked
 * so it fades out; on its own (`whole`), one wider than the card scrolls
 * sideways, fading out at the edges that have more, and takes the keyboard.
 */
function EmbedArt({ svg, embed, whole = false }: { svg: string; embed: CardEmbed; whole?: boolean }) {
  const size = pictureSize(svg)
  const sizing = size ? ({ "--picture-width": `${size.width}px`, "--picture-ratio": size.width / size.height } as CSSProperties) : undefined
  const art = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const [more, setMore] = useState({ left: false, right: false })
  useLayoutEffect(() => {
    const box = art.current
    if (!box) return
    const measure = () => {
      setClipped(box.scrollHeight > box.clientHeight + 1)
      const left = box.scrollLeft > 1
      const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 1
      setMore((current) => (current.left === left && current.right === right ? current : { left, right }))
    }
    // A ResizeObserver reports each box once when it starts watching it.
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    if (box.firstElementChild) observer.observe(box.firstElementChild)
    box.addEventListener("scroll", measure, { passive: true })
    return () => {
      observer.disconnect()
      box.removeEventListener("scroll", measure)
    }
  }, [svg])
  const scrolls = whole && (more.left || more.right)
  return (
    <div
      ref={art}
      role="img"
      aria-label={`${KIND_NAMES[embed.kind]} ${embed.path}`}
      tabIndex={scrolls ? 0 : undefined}
      data-clipped={(!whole && clipped) || undefined}
      data-more-left={(whole && more.left) || undefined}
      data-more-right={(whole && more.right) || undefined}
      className={cn("card-art min-w-0", whole && "card-art-whole w-full")}
      style={sizing}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** A drawing or diagram a note embeds, in the library's embed box, with its kind and a link to its file. */
export function EmbedFigure({ embed, svgs }: { embed: CardEmbed; svgs: Record<string, string> }) {
  const svg = svgFor(embed, svgs)
  return (
    <EmbedBox
      floatingCaption={Boolean(svg)}
      caption={
        <>
          <KindBadge kind={badgeKind(embed.kind)} />
          <a href={embed.url ?? undefined} className="min-w-0 truncate text-dim underline-offset-2 hover:text-foreground hover:underline">
            {embed.path}
          </a>
        </>
      }
    >
      {svg ? (
        <EmbedArt svg={svg} embed={embed} />
      ) : (
        <div className="text-center text-[13px] leading-snug text-muted-foreground">{EMBED_NOTES[embed.status]}</div>
      )}
      {svg && embed.status === "stale" && <Banner tone="warn">{EMBED_NOTES.stale}</Banner>}
    </EmbedBox>
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
  onEdit,
  onSave,
  onCancel,
  onReload,
}: Pick<CardViewProps, "canEdit" | "onEdit" | "onSave" | "onCancel" | "onReload"> & { state: Extract<CardState, { phase: "shown" }> }) {
  const { mode, busy, dirty, status, file } = state
  const editable = canEdit && file.source !== null
  const statusText =
    status.kind === "saving" ? (
      <StatusDot status="unsaved">Saving</StatusDot>
    ) : status.kind === "saved" ? (
      <StatusDot status="synced">Saved as v{status.version}.</StatusDot>
    ) : mode === "edit" && dirty ? (
      <StatusDot status="unsaved" />
    ) : null
  if (mode === "read" && !editable && !statusText) return null
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 max-[500px]:px-3">
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
