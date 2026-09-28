import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: shadcn has no figure. This is a drawing or
// diagram in a rendered note (reading.css's figure[data-resource]) as a
// component, for places outside the preview frame such as the chat card.

/**
 * A drawing or diagram in a note: the picture centred in a bordered box of
 * radius 10 on the dotted page (22px dots), padding 16, at least 150 high
 * (130 on a phone). The picture has no background of its own, so the dots
 * show through. `caption` goes under the picture: the file's kind and name.
 */
export function EmbedBox({ caption, className, children, ...props }: ComponentProps<"figure"> & { caption?: ReactNode }) {
  return (
    <figure
      data-slot="embed-box"
      className={cn(
        "m-0 flex min-h-[150px] min-w-0 flex-col justify-center gap-3 rounded-tile border border-border p-4 max-[500px]:min-h-[130px]",
        "bg-(--bg) bg-[radial-gradient(var(--dot)_1px,transparent_1.4px)] bg-size-[22px_22px]",
        className,
      )}
      {...props}
    >
      {children}
      {caption && (
        <figcaption className="flex min-w-0 items-center gap-2 font-mono text-xs leading-[1.4] text-dim">{caption}</figcaption>
      )}
    </figure>
  )
}
