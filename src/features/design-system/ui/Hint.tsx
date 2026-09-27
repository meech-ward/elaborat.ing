import type { ReactElement } from "react"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A tooltip naming a control and its shortcut, for icon buttons: the shadcn
 * tooltip over the child, which Base UI renders as the trigger. It shows on
 * hover and on keyboard focus. The tooltip is only a hint: give the child
 * its own accessible name too (aria-label="Focus (⌘.)").
 */
export function Hint({
  label,
  shortcut,
  side = "bottom",
  children,
}: {
  label: string
  shortcut?: string
  side?: "top" | "bottom" | "left" | "right"
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
