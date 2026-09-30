import { useEffect, useState } from "react"
import { loadClient } from "@/lib/supabase/client"

/**
 * How many agents the signed-in person has connected, from the same list the
 * Connected agents page shows, read once when `enabled` turns on. Null while
 * it loads, when it cannot be read, and when not `enabled`.
 */
export function useConnectedAgentCount(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    loadClient()
      .then((client) => client.auth.oauth.listGrants())
      .then(
        ({ data, error }) => alive && !error && setCount(data?.length ?? 0),
        () => undefined,
      )
    return () => {
      alive = false
    }
  }, [enabled])
  return enabled ? count : null
}
