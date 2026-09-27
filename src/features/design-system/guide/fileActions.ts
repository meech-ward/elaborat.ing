import type { MenuEntry } from "../ui/ActionMenu"
import { commandShortcut, isApplePlatform } from "../ui/shortcuts"

/**
 * The style guide's file menu: Rename, Duplicate, Move to… and Delete, with
 * this platform's keys (⌘D on Apple platforms, Ctrl+D elsewhere).
 */
export function fileActions(choose: (label: string) => void, apple = isApplePlatform()): MenuEntry[] {
  const duplicate = commandShortcut("D", apple)
  return [
    { label: "Rename", shortcut: "F2", keyShortcuts: "F2", onSelect: () => choose("Rename") },
    { label: "Duplicate", shortcut: duplicate.label, keyShortcuts: duplicate.aria, onSelect: () => choose("Duplicate") },
    { label: "Move to…", onSelect: () => choose("Move to…") },
    { label: "Delete", shortcut: "⌫", keyShortcuts: "Backspace", destructive: true, onSelect: () => choose("Delete") },
  ]
}
