import { useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { z } from "zod/mini"
import { registerBeforeSignOut } from "@/features/auth"
import { parseProjectLocation } from "@/features/navigation"
import { DepartureBarrier } from "@/features/project-storage/departureBarrier"
import type { PrepareProjectLeave } from "@/features/workbench/projectLeave"

/**
 * Leaving a project (to another project, the project list, or by signing
 * out) first keeps every open file's edits as drafts on this device, or
 * stops with the reason. Moving between files of the same project is not
 * leaving.
 */
export function useDepartureGuard(projectId: string, opened: boolean) {
  const router = useRouter()
  const [departure] = useState(() => new DepartureBarrier())
  const [error, setError] = useState<string | null>(null)
  const leaveGuard = useRef<PrepareProjectLeave | null>(null)
  const registerLeaveGuard = useCallback((guard: PrepareProjectLeave | null) => {
    leaveGuard.current = guard
  }, [])

  const prepareDeparture = useCallback(async () => {
    const finish = departure.begin()
    try {
      if (!leaveGuard.current && opened) throw new Error("Wait for the project to finish opening before leaving.")
      const release = leaveGuard.current ? await leaveGuard.current() : () => {}
      let released = false
      return () => {
        if (released) return
        released = true
        release()
        finish()
      }
    } catch (cause) {
      finish()
      throw cause
    }
  }, [departure, opened])
  const currentDeparture = useRef(prepareDeparture)
  useLayoutEffect(() => {
    currentDeparture.current = prepareDeparture
  }, [prepareDeparture])

  const routeDeparture = useRef<(() => void) | null>(null)
  const routeRequest = useRef(0)
  useEffect(
    () =>
      router.history.block({
        enableBeforeUnload: false,
        blockerFn: async ({ nextLocation, action }) => {
          const request = ++routeRequest.current
          const next = parseProjectLocation(nextLocation.href)
          if (next.kind === "project" && next.projectId === projectId) return false
          const currentLocation = router.history.location
          const browserEntry = z.object({ __TSR_index: z.int() }).safeParse(window.history.state)
          const unindexedTraversal = action === "GO" && (!browserEntry.success || browserEntry.data.__TSR_index === currentLocation.state.__TSR_index)
          const refuse = () => {
            if (!unindexedTraversal) return true
            // A native traversal with no router index would otherwise be
            // rolled back with go(0), reloading the page and its live edits.
            router.history.replace(currentLocation.href, currentLocation.state, { ignoreBlocker: true })
            return false
          }
          try {
            const release = await currentDeparture.current()
            if (request !== routeRequest.current) {
              release()
              return !unindexedTraversal
            }
            routeDeparture.current = release
            setError(null)
            return false
          } catch (cause) {
            setError(`Stayed in this project: ${cause instanceof Error ? cause.message : String(cause)}`)
            return refuse()
          }
        },
      }),
    [projectId, router],
  )
  useEffect(() => {
    // Release once the router settles, including a traversal cancelled back here.
    const requests = routeRequest
    const release = () => {
      routeDeparture.current?.()
      routeDeparture.current = null
    }
    const unsubscribe = router.subscribe("onResolved", release)
    return () => {
      unsubscribe()
      ++requests.current
      release()
    }
  }, [router])
  useEffect(() => registerBeforeSignOut(prepareDeparture), [prepareDeparture])

  return { registerLeaveGuard, departureError: error, clearDepartureError: () => setError(null) }
}
