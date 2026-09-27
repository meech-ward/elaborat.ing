import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { floatingPanelVariants } from "./FloatingPanel"

// No shadcn primitive fits: the header is a plain row of controls. It is not
// a toolbar, because the tabs and the view switch in it already use the
// arrow keys.

/**
 * The editor's header: the open files, the view switch, Save and Focus in one
 * row, 6 apart and 6 in from the ends. `line` is the top line of the editor
 * panel, 46 high on the panel fill over a 1px panel-border rule (52 on touch
 * screens).
 * `floating` is focus mode's header on a panel of its own, 44 high with
 * radius 12 and the panel shadow; C5 places it 16 from the top and right.
 */
export const editorHeaderVariants = cva("flex min-w-0 shrink-0 items-center gap-1.5 px-1.5", {
  variants: {
    variant: {
      line: "h-[46px] border-b border-border bg-panel pointer-coarse:h-[52px]",
      floating: cn(floatingPanelVariants(), "h-11 rounded-menu pointer-coarse:h-[52px]"),
    },
  },
  defaultVariants: { variant: "line" },
})

export function EditorHeader({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof editorHeaderVariants>) {
  return (
    <div
      data-slot="editor-header"
      data-variant={variant ?? "line"}
      className={cn(editorHeaderVariants({ variant }), className)}
      {...props}
    />
  )
}
