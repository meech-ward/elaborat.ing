/**
 * Keys that switch a file's view: ⌘⌥1 to 3 on Apple platforms and Ctrl+Alt+1
 * to 3 elsewhere (⌘1 and Ctrl+1 switch browser tabs, so they never reach the
 * page). The digit is read from `event.code`, because ⌥ changes `event.key`
 * on a Mac. Outside Apple platforms Ctrl+Alt can be AltGr, which types a
 * character: then `event.key` is not the digit and typing wins. How the keys
 * read in tooltips is the design system's (viewShortcut, commandShortcut).
 */
import { commandShortcut, isApplePlatform } from "@/features/design-system";

/** The digit (1 to 3) a view shortcut names, or null when the event is not one. */
export function viewShortcutDigit(
  event: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  apple: boolean,
): 1 | 2 | 3 | null {
  const match = /^Digit([1-3])$/.exec(event.code);
  if (!match || !event.altKey || event.shiftKey) return null;
  if (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  if (!apple && event.key !== match[1]) return null;
  return Number(match[1]) as 1 | 2 | 3;
}

/** How ⌘D / Ctrl+D (duplicate the file) reads in a menu. */
export function duplicateShortcutLabel(apple: boolean = isApplePlatform()): string {
  return commandShortcut("D", apple).label;
}
