import { cva } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import type { PanelRowSize } from "./PanelRow"

// A panel's words where its rows would be. No shadcn primitive is a line of
// panel text: it is a paragraph in the panel's row size.

/** Muted, 13px beside the desktop's rows and 15px beside a phone's (`touch`), as PanelRow. */
export const panelMessageVariants = cva("leading-snug text-muted-foreground", {
  variants: {
    size: {
      default: "text-[13px]",
      touch: "text-[15px]",
    },
  },
  defaultVariants: { size: "default" },
})

/** A line in a panel in place of rows, such as Loading files… or No files yet. Give it `role="status"` when it changes. */
export function PanelMessage({ size = "default", className, ...props }: ComponentProps<"p"> & { size?: PanelRowSize }) {
  return <p data-slot="panel-message" className={cn(panelMessageVariants({ size }), className)} {...props} />
}
