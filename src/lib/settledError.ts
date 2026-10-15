import { useCallback, useEffect, useState } from "react"

/**
 * How long the person's typing pauses before an error in what they typed
 * shows: longer than the gap between keystrokes for all but the slowest
 * typing (most gaps are well under half a second), and within the second in
 * which a response still reads as an answer to what they did.
 */
export const TYPING_PAUSE_MS = 1000

/**
 * Whether the person is typing into a text, for useSettledError. `typed`
 * notes one of their own edits (never text that arrived); the typing lasts
 * until it pauses for TYPING_PAUSE_MS, or until `settle` notes that they act
 * on the text (Save, a view switch, an export), which ends it at once.
 */
export function useTyping(): { typing: boolean; typed: () => void; settle: () => void } {
  const [edits, setEdits] = useState({ made: 0, settled: 0 })
  useEffect(() => {
    if (edits.made === edits.settled) return
    const timer = window.setTimeout(() => setEdits((now) => ({ ...now, settled: edits.made })), TYPING_PAUSE_MS)
    return () => window.clearTimeout(timer)
  }, [edits])
  const typed = useCallback(() => setEdits((now) => ({ ...now, made: now.made + 1 })), [])
  const settle = useCallback(() => setEdits((now) => (now.made === now.settled ? now : { ...now, settled: now.made })), [])
  return { typing: edits.made !== edits.settled, typed, settle }
}

/**
 * `error` as the person sees it while they type into the text it is about.
 * While they are `typing` (useTyping), a new error waits, so the view keeps
 * its last good state; an error already showing stays until the text is
 * fixed, and goes as soon as it is. Otherwise an error shows at once: once
 * their typing pauses or they act on the text, and in text that arrived
 * (opened, an agent's save, an edit from elsewhere). An error found in an
 * earlier version of the text, while the check of the text there now has not
 * finished (`current` false), shows nothing new either: it may be fixed
 * already. `error` must keep its identity while it does not change: a
 * string, or a memoized value.
 */
export function useSettledError<T>(error: T | null, typing: boolean, current = true): T | null {
  const [shown, setShown] = useState(error)
  const next = error === null ? null : typing || !current ? shown : error
  if (next !== shown) setShown(next)
  return next
}
