import { Outlet, createRootRoute, useRouter, useRouterState } from "@tanstack/react-router"
import { lazy, Suspense, type ReactNode } from "react"
import { embedded } from "@/features/embed/mode"
import { loadEmbedRoot } from "@/features/embed/load"
import { UpdateReady } from "@/features/updates"

// In a panel (/embed) the embed's own chunk draws the page around the routes,
// and no service worker registers: the app is not kept for offline use there.
const EmbedRoot = lazy(() => loadEmbedRoot().then((module) => ({ default: module.EmbedRoot })))

/**
 * The page on screen, which takes no input once a link to another page has
 * been followed: it stays drawn while that page's code downloads, until the
 * loading state replaces it (main.tsx), and nothing typed or clicked reaches
 * it. A move within the same page, such as to another file of a project,
 * leaves it as it is.
 */
function Page({ children }: { children: ReactNode }) {
  const router = useRouter()
  const leaving = useRouterState({
    select: (state) => state.status === "pending" && router.getMatchedRoutes(state.location.pathname)[0][1]?.id !== state.matches[1]?.routeId,
  })
  return (
    <div className="contents" inert={leaving}>
      {children}
    </div>
  )
}

export const Route = createRootRoute({
  component: () =>
    embedded ? (
      <Page>
        <Suspense
          fallback={
            // index.html's shell, while the embed's chunk (started with the first route) finishes.
            <div className="app-shell" role="status" aria-label="Loading elaborat.ing" />
          }
        >
          <EmbedRoot />
        </Suspense>
      </Page>
    ) : (
      <>
        <Page>
          <Outlet />
        </Page>
        <UpdateReady />
      </>
    ),
})
