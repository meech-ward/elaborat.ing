import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// No shadcn primitive fits as is: Card renders only a div, and these panels
// are landmarks (the files panel is a nav), so FloatingPanel draws the same
// surface through Base UI's useRender and takes a `render` element.

/**
 * The panel fill with a 1px border and radius 14. `floating` adds the panel
 * shadow (desktop, where panels float on the dotted page); `flat` has none
 * (the phone's full-screen lists). Padding and layout belong to what is
 * inside.
 */
export const floatingPanelVariants = cva("rounded-panel border border-border bg-panel text-foreground", {
  variants: {
    variant: {
      floating: "shadow-panel",
      flat: "",
    },
  },
  defaultVariants: { variant: "floating" },
})

export type FloatingPanelProps = useRender.ComponentProps<"div"> & VariantProps<typeof floatingPanelVariants>

export function FloatingPanel({ className, variant, render, ...props }: FloatingPanelProps) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">({ className: cn(floatingPanelVariants({ variant }), className) }, props),
    state: { slot: "floating-panel", variant: variant ?? "floating" },
  })
}
