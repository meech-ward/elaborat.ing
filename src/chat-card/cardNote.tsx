// The pieces of a note as the chat card shows it, shared by the card
// (CardView.tsx) and the component preview's frame (preview/runtime.tsx),
// which renders a note with components the way the card renders the rest:
// the note's type, and its drawings and diagrams in the library's embed box.
// Nothing here parses results, so the frame's bundle carries no schema library.
import "./card.css"
import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react"
import { Banner } from "@/features/design-system/ui/Banner"
import { EmbedBox } from "@/features/design-system/ui/EmbedBox"
import { KindBadge, type FileKind as BadgeKind } from "@/features/design-system/ui/KindBadge"
import { pictureSize } from "@/features/rendered/resourceViewer.ts"
import { cn } from "@/lib/utils"
import { EMBED_NOTES, KIND_NAMES, svgFor, type CardEmbed, type FileKind } from "./embedText"

export const badgeKind = (kind: FileKind): BadgeKind => (kind === "file" ? "text" : kind === "component" ? "note" : kind)

/**
 * The note's type: the app's rendered view's (src/preview/noteType.css, in
 * card.css), on the element whose children are the note's blocks. The
 * rendered editor puts it on its own root (fluidEditor.ts).
 */
export const READING_CLASS = "reading-document preview-prose prose max-w-none"

/** A note's page: the reader's text size (card.css), inside the card's padding. */
export function CardNote({ className, ...props }: ComponentProps<"article">) {
  return <article className={cn("card-note px-6 py-5 text-foreground max-[500px]:px-4 max-[500px]:py-4", className)} {...props} />
}

/**
 * The server's SVG of a drawing, which escapes everything it takes from the
 * file. It shows at a readable size (card.css): its own width and width to
 * height ratio set that. In a note, a picture cut off at the bottom is marked
 * so it fades out; on its own (`whole`), one wider than the card scrolls
 * sideways, fading out at the edges that have more, and takes the keyboard.
 */
export function EmbedArt({ svg, embed, whole = false }: { svg: string; embed: CardEmbed; whole?: boolean }) {
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
      className="not-prose"
      floatingCaption={Boolean(svg)}
      message={svg ? undefined : EMBED_NOTES[embed.status]}
      caption={
        <>
          <KindBadge kind={badgeKind(embed.kind)} />
          <a href={embed.url ?? undefined} className="min-w-0 truncate text-dim underline-offset-2 hover:text-foreground hover:underline">
            {embed.path}
          </a>
        </>
      }
    >
      {svg && <EmbedArt svg={svg} embed={embed} />}
      {svg && embed.status === "stale" && <Banner tone="warn">{EMBED_NOTES.stale}</Banner>}
    </EmbedBox>
  )
}

