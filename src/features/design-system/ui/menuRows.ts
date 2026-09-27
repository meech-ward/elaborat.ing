/** One entry in a menu. The same list feeds a button menu and a right-click menu. */
export interface MenuEntry {
  label: string
  onSelect: () => void
  /** The shortcut shown at the item's right end, such as ⌘D. Screen readers skip it. */
  shortcut?: string
  /** The same shortcut for assistive technology, in aria-keyshortcuts form: "Meta+D". */
  keyShortcuts?: string
  /** Removes something: shown in the danger colour, after a separator, last. */
  destructive?: boolean
  disabled?: boolean
}

export type MenuRow = { kind: "item"; entry: MenuEntry } | { kind: "separator"; key: string }

/**
 * The rows of a menu: the safe entries in their order, then, after one
 * separator, the destructive ones. No separator when either side is empty.
 */
export function menuRows(entries: readonly MenuEntry[]): MenuRow[] {
  const safe = entries.filter((entry) => !entry.destructive)
  const destructive = entries.filter((entry) => entry.destructive)
  return [
    ...safe.map((entry): MenuRow => ({ kind: "item", entry })),
    ...(safe.length > 0 && destructive.length > 0 ? [{ kind: "separator", key: "destructive" } as const] : []),
    ...destructive.map((entry): MenuRow => ({ kind: "item", entry })),
  ]
}
