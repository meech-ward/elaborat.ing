import { useEffect, useState } from "react"

/**
 * How long the person's typing pauses before an error in what they typed
 * shows: longer than the gap between keystrokes for all but the slowest
 * typing (most gaps are well under half a second), and within the second in
 * which a response still reads as an answer to what they did.
 */
export const TYPING_PAUSE_MS = 1000

/**
 * `error` as the person sees it while they type into the text it is about.
 * `typed` counts their own edits to that text, never text that arrived.
 * While they type, a new error waits until they pause for TYPING_PAUSE_MS,
 * so the view keeps its last good state; an error already showing stays
 * until the text is fixed, and goes as soon as it is. An error in text that
 * arrived (opened, an agent's save, an edit from elsewhere) shows at once,
 * unless the person typed in the last moment. `error` must keep its identity
 * while it does not change: a string, or a memoized value.
 */
export function useSettledError<T>(error: T | null, typed: number): T | null {
  const [paused, setPaused] = useState(typed)
  const [shown, setShown] = useState(error)
  useEffect(() => {
    if (typed === paused) return
    const timer = window.setTimeout(() => setPaused(typed), TYPING_PAUSE_MS)
    return () => window.clearTimeout(timer)
  }, [typed, paused])
  const next = error === null ? null : typed === paused ? error : shown
  if (next !== shown) setShown(next)
  return next
}
