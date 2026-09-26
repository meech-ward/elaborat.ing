import { useEffect } from "react"
import type { ProjectLibrary } from "@/features/project-storage/library"

const INTERVAL_MS = 60_000

/**
 * Keep the project list current and send changes waiting on this device: now,
 * when the window regains focus or the connection returns, and every minute.
 */
export function useBackgroundRefresh(library: ProjectLibrary, onError: (message: string) => void) {
  useEffect(() => {
    const refresh = () => {
      library
        .refresh()
        .then(() => (library.getState().offline ? undefined : library.syncWaiting()))
        .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    }
    refresh()
    const timer = window.setInterval(refresh, INTERVAL_MS)
    window.addEventListener("online", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("online", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [library, onError])
}
