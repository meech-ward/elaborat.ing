import { useCallback, useMemo } from "react"
import { useRouter, useRouterState } from "@tanstack/react-router"
import { parseProjectLocation, projectHref } from "./location"

/** Where the URL points inside a project, as the workbench reads it. */
export type FileTarget = { kind: "workspace"; projectId: string; path: string | null } | { kind: "invalid"; message: string }

/**
 * The router's href, as the project page on screen reads it. A link to
 * another page leaves this one drawn until that page is ready
 * (routes/__root.tsx), with the router's location already the other page's:
 * until then the project page keeps the link it showed, rather than read the
 * other page's as a broken project link.
 */
export function useProjectHref(): string {
  return useRouterState({
    select: (state) => (state.location.href.startsWith("/projects/") ? state.location : (state.resolvedLocation ?? state.location)).href,
  })
}

/** The current project file location, and navigation to another (without the router's default scroll reset). */
export function useFileLocation() {
  const href = useProjectHref()
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
