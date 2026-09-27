import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DirtyDot } from "./StatusDot"
import { Hint } from "./Hint"

type ButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size" | "children" | "aria-label">

/**
 * A toolbar icon button: the ghost Button at 30 (radius 8, muted icon, the
 * text colour and a seg wash on hover), 40 on touch screens. `label` is its
 * accessible name and, with the shortcut, its tooltip, as in Focus ⌘. .
 */
export function IconButton({
  label,
  shortcut,
  keyShortcuts,
  tooltipSide = "bottom",
  className,
  children,
  ...props
}: ButtonProps & {
  label: string
  /** The shortcut as the tooltip shows it, e.g. ⌘. */
  shortcut?: string
  /** The same shortcut as an aria-keyshortcuts value, e.g. Meta+. */
  keyShortcuts?: string
  tooltipSide?: "top" | "bottom" | "left" | "right"
  /** The icon. */
  children: ReactNode
}) {
  return (
    <Hint label={label} shortcut={shortcut} side={tooltipSide}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-keyshortcuts={keyShortcuts}
        className={cn("pointer-coarse:size-10", className)}
        {...props}
      >
        {children}
      </Button>
    </Hint>
  )
}

/**
 * The phone's floating round button, over the open file: 40 across, the
 * panel colour with a 1px panel-border ring and a soft shadow, a 20px icon
 * in the text colour. `dirty` adds the 8px unsaved dot at its top right and
 * says so in the accessible name ("Save, unsaved changes"). No tooltip:
 * phones have no pointer to hover with.
 */
export function RoundIconButton({
  label,
  dirty = false,
  className,
  children,
  ...props
}: ButtonProps & {
  label: string
  dirty?: boolean
  /** The icon. */
  children: ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      aria-label={dirty ? `${label}, unsaved changes` : label}
      className={cn(
        "relative rounded-full border-panel-border bg-panel text-foreground shadow-[0_6px_18px_var(--shadow)] hover:bg-[color-mix(in_oklab,var(--seg)_50%,var(--panel))] hover:text-foreground active:bg-seg",
        className,
      )}
      {...props}
    >
      {children}
      {dirty && <DirtyDot className="absolute top-[7px] right-[7px] size-2" />}
    </Button>
  )
}
