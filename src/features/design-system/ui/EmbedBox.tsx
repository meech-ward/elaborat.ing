import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: shadcn has no figure. This is a drawing or
// diagram in a rendered note (reading.css's figure[data-resource]) as a
// component, for places outside the preview frame such as the chat card.

/**
 * A drawing or diagram in a note: the picture centred in a bordered box of
 * radius 10 on the dotted page (22px dots), padding 16, at least 150 high
 * (130 on a phone). The picture has no background of its own, so the dots
 * show through. `caption` is the file's kind and name: under the picture,
 * or with `floatingCaption` (when there is a picture), over the box's top
 * edge while it is pointed at or has focus, as the rendered note shows it;
 * touch screens, which cannot point, keep it under the picture.
 *
 * With no picture, `message` says why in one short line: the caption and
 * the message sit together in the middle of the box, on a patch of plain
 * page so the dots don't run through the words.
 */
export function EmbedBox({
  caption,
  floatingCaption = false,
  message,
  className,
  children,
  ...props
}: ComponentProps<"figure"> & { caption?: ReactNode; floatingCaption?: boolean; message?: ReactNode }) {
  return (
    <figure
      data-slot="embed-box"
      className={cn(
        "group/embed relative m-0 flex min-h-[150px] min-w-0 flex-col justify-center gap-3 rounded-tile border border-border p-4 max-[500px]:min-h-[130px]",
        "bg-(--bg) bg-[radial-gradient(var(--dot)_1px,transparent_1.4px)] bg-size-[22px_22px]",
        className,
      )}
      {...props}
    >
      {children}
      {message ? (
        <figcaption className="mx-auto flex max-w-full min-w-0 flex-col items-center gap-1 rounded-row bg-(--bg) px-3 py-2 text-center">
          {caption && <span className="flex max-w-full min-w-0 items-center gap-2 font-mono text-xs leading-[1.4] text-dim">{caption}</span>}
          <span className="text-[13px] leading-snug text-muted-foreground">{message}</span>
        </figcaption>
      ) : (
        caption && (
          <figcaption
            className={cn(
              "flex min-w-0 items-center gap-2 font-mono text-xs leading-[1.4] text-dim",
              floatingCaption &&
                "pointer-fine:absolute pointer-fine:top-1.5 pointer-fine:right-1.5 pointer-fine:left-3 pointer-fine:opacity-0 pointer-fine:group-focus-within/embed:opacity-100 pointer-fine:group-hover/embed:opacity-100",
            )}
          >
            {caption}
          </figcaption>
        )
      )}
    </figure>
  )
}
