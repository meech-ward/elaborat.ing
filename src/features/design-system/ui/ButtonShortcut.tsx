import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/**
 * The shortcut inside a button, as in Save ⌘S: 11px mono in the button's own
 * colour. Screen readers skip it; put the shortcut on the button as
 * aria-keyshortcuts="Meta+S" instead. (The Kbd primitive is the key on a
 * seg fill; inside a filled button the style guide shows the bare text.)
 */
export function ButtonShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden="true" className={cn("font-mono text-[11px] font-normal", className)} {...props} />
}
