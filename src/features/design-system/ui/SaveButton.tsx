import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ButtonShortcut } from "./ButtonShortcut"
import { commandShortcut, isApplePlatform } from "./shortcuts"

/**
 * The editor's Save: the primary Button at the toolbar size (30 high, padding
 * 12, gap 8) with its shortcut after the word, ⌘S on Apple platforms and
 * Ctrl+S elsewhere. The shortcut is also the button's aria-keyshortcuts.
 * Disabled while there is nothing to save or a save is under way. 40 high on
 * touch screens.
 */
export function SaveButton({
  className,
  children = "Save",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  const shortcut = commandShortcut("s", isApplePlatform())
  return (
    <Button size="sm" aria-keyshortcuts={shortcut.aria} className={cn("gap-2 pointer-coarse:h-10", className)} {...props}>
      {children}
      <ButtonShortcut>{shortcut.label}</ButtonShortcut>
    </Button>
  )
}
