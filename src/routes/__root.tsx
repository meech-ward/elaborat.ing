import { Outlet, createRootRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { embedded } from "@/features/embed/mode"
import { loadEmbedRoot } from "@/features/embed/load"
import { UpdateReady } from "@/features/updates"

// In a panel (/embed) the embed's own chunk draws the page around the routes,
// and no service worker registers: the app is not kept for offline use there.
const EmbedRoot = lazy(() => loadEmbedRoot().then((module) => ({ default: module.EmbedRoot })))

export const Route = createRootRoute({
  component: () =>
    embedded ? (
      <Suspense
        fallback={
          // index.html's shell, while the embed's chunk (started with the first route) finishes.
          <div className="app-shell" role="status" aria-label="Loading elaborat.ing" />
        }
      >
        <EmbedRoot />
      </Suspense>
    ) : (
      <>
        <Outlet />
        <UpdateReady />
      </>
    ),
})
