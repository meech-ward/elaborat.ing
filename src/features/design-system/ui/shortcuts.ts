// How the editor's shortcuts read on this platform: the symbol keys on Apple
// platforms, the word keys elsewhere. Each shortcut comes as the text a
// tooltip or button shows and the matching aria-keyshortcuts value.

export type Shortcut = { label: string; aria: string }

/** True on macOS, iOS and iPadOS, where the command key stands for Ctrl. */
export function isApplePlatform(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

/**
 * The key that switches to the nth view: ⌘⌥1 to 3 on Apple platforms and
 * Ctrl+Alt+1 to 3 elsewhere (⌘1 and Ctrl+1 switch browser tabs).
 */
export function viewShortcut(digit: 1 | 2 | 3, apple: boolean): Shortcut {
  return apple
    ? { label: `⌘⌥${digit}`, aria: `Meta+Alt+${digit}` }
    : { label: `Ctrl+Alt+${digit}`, aria: `Control+Alt+${digit}` }
}

/** Show or hide the comments: ⌘⌥M on Apple platforms, Ctrl+Alt+M elsewhere (⌘M minimises the window). */
export function commentsShortcut(apple: boolean): Shortcut {
  return apple ? { label: "⌘⌥M", aria: "Meta+Alt+M" } : { label: "Ctrl+Alt+M", aria: "Control+Alt+M" }
}

/** A command-key shortcut such as Save (⌘S, Ctrl+S) or Focus (⌘., Ctrl+.). */
export function commandShortcut(key: string, apple: boolean): Shortcut {
  const name = key.toUpperCase()
  return apple ? { label: `⌘${name}`, aria: `Meta+${name}` } : { label: `Ctrl+${name}`, aria: `Control+${name}` }
}
