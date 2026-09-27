import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

// No shadcn primitive fits: shadcn has no typography component. This is a
// rendered note's type from C5 screen 1, applied to the plain elements a note
// renders to (h1, h2, p, ol, li, figure) and to its callouts.

/**
 * A rendered note: padding 30 by 40, the text in a 680 column with 14 between
 * blocks. H1 32/1.15 at 700, H2 21 at 600 with 6 more above, paragraphs and
 * list items 15.5/1.6 in the body colour, numbered lists indented 22.
 * Callouts (Callout with an icon) take 15/1.55 with 12 between the icon and
 * the text.
 */
export function NoteProse({ className, children, ...props }: ComponentProps<"article">) {
  return (
    <article className={cn("px-10 py-[30px] text-foreground", className)} {...props}>
      <div
        className={cn(
          "mx-auto flex max-w-[680px] flex-col gap-3.5",
          "[&_h1]:m-0 [&_h1]:text-[32px] [&_h1]:leading-[1.15] [&_h1]:font-bold",
          "[&_h2]:mt-1.5 [&_h2]:mb-0 [&_h2]:text-[21px] [&_h2]:leading-[1.3] [&_h2]:font-semibold",
          "[&_li]:text-[15.5px] [&_li]:leading-[1.6] [&_li]:text-body [&_p]:m-0 [&_p]:text-[15.5px] [&_p]:leading-[1.6] [&_p]:text-body",
          "[&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-[22px] [&_figure]:m-0",
          "[&_[data-slot=alert]]:gap-x-3 [&_[data-slot=alert]]:text-[15px] [&_[data-slot=alert]]:leading-[1.55] [&_[data-slot=alert]>svg]:translate-y-[3px]",
        )}
      >
        {children}
      </div>
    </article>
  )
}
