import { useCallback, useMemo } from "react"
import { useLocation, useRouter } from "@tanstack/react-router"
import { parseProjectLocation, projectHref } from "./location"

/** Where the URL points inside a project, as the workbench reads it. */
export type FileTarget = { kind: "workspace"; projectId: string; path: string | null } | { kind: "invalid"; message: string }

/** The current project file location, and navigation to another (without the router's default scroll reset). */
export function useFileLocation() {
  const href = useLocation({ select: (location) => location.href })
  const target = useMemo<FileTarget>(() => {
    const parsed = parseProjectLocation(href)
    return parsed.kind === "project" ? { kind: "workspace", projectId: parsed.projectId, path: parsed.path } : parsed
  }, [href])
  const router = useRouter()
  const navigate = useCallback(
    (projectId: string, path: string | null, replace = false, ignoreBlocker = false) => {
      const next = projectHref(projectId, path)
      if (router.latestLocation.href === next) return Promise.resolve()
      return router.navigate({ href: next, replace, ignoreBlocker, resetScroll: false })
    },
    [router],
  )
  return { href, target, navigate }
}
