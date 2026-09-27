// Which tabs of a tab line don't fit, from the tabs' positions in the list.
// The list clips (it never scrolls by hand): a tab is either wholly in view
// or hidden and listed under "+N".

/** A tab's box along the list, in the list's own coordinates. */
export type TabBox = { value: string; left: number; width: number }

/**
 * The tabs not wholly in view between `start` and `start + width`, in tab
 * order, and the empty width after the last tab in view (where a hidden tab
 * sits), which "+N" moves left over so it follows the last visible tab.
 */
export function clippedTabs(tabs: readonly TabBox[], start: number, width: number): { clipped: string[]; gap: number } {
  // Tabs with no width are not laid out (hidden, or before the first
  // layout): nothing is clipped. A list squeezed to no width clips them all.
  if (tabs.every((tab) => tab.width === 0)) return { clipped: [], gap: 0 }
  const end = start + width
  const clipped: string[] = []
  let edge = 0
  for (const tab of tabs) {
    const right = tab.left + tab.width
    // One pixel of slack for subpixel layout.
    if (tab.left < start - 1 || right > end + 1) clipped.push(tab.value)
    else edge = Math.max(edge, right - start)
  }
  return { clipped, gap: clipped.length ? Math.max(0, Math.floor(width - edge)) : 0 }
}

/**
 * Where the list should start so a tab is wholly in view: unchanged when it
 * already is, else the nearest start that begins at a tab's left edge, so no
 * tab is cut on the left.
 */
export function revealStart(tabs: readonly TabBox[], value: string, start: number, width: number): number {
  const tab = tabs.find((candidate) => candidate.value === value)
  if (!tab) return start
  const right = tab.left + tab.width
  if (tab.left < start) return tab.left
  if (right <= start + width) return start
  return tabs.map((candidate) => candidate.left).find((left) => left >= right - width && left <= tab.left) ?? tab.left
}
