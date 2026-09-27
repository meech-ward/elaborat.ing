import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

// One row in a floating panel: the tree's folder and file rows and the
// account panel's rows are all PanelRows. Built on shadcn's
// SidebarMenuButton, so a row sits in a SidebarMenuItem inside a SidebarMenu
// and needs a SidebarProvider above it (the workbench has one).

/**
 * 28 high, radius 7, 13px text, 8px side padding and a 7px gap (16px icons).
 * Hover takes the seg fill (also while the pointer is on the row's hover
 * action); the selected row (`isActive`) takes accentSoft with
 * accentSoftText at 600. Focus draws a 2px ring inside the row. `touch` is
 * the phone row: 40 high, radius 9, 15px, 10px padding and gap. The desktop
 * row also grows to 40 on touch screens.
 */
export const panelRowVariants = cva(
  "gap-[7px] rounded-row px-2 py-0 text-foreground hover:bg-seg hover:text-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid active:bg-seg active:text-foreground not-data-active:group-hover/menu-item:bg-seg data-active:bg-accent-soft data-active:font-semibold data-active:text-accent-soft-text data-active:hover:bg-accent-soft data-active:hover:text-accent-soft-text data-active:active:bg-accent-soft data-active:active:text-accent-soft-text motion-reduce:transition-none",
  {
    variants: {
      size: {
        default: "h-7 text-[13px] pointer-coarse:h-10",
        touch: "h-10 gap-2.5 rounded-button px-2.5 text-[15px]",
      },
    },
    defaultVariants: { size: "default" },
  },
)

export type PanelRowSize = NonNullable<VariantProps<typeof panelRowVariants>["size"]>

export type PanelRowProps = Omit<ComponentProps<typeof SidebarMenuButton>, "size" | "variant" | "tooltip"> & {
  size?: PanelRowSize
}

export function PanelRow({ size = "default", className, ...props }: PanelRowProps) {
  return <SidebarMenuButton data-row-size={size} className={cn(panelRowVariants({ size }), className)} {...props} />
}
