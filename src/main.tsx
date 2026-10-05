import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { AppearanceProvider, type ColorMode } from "./features/appearance"
import { PageLoading } from "./features/design-system"
import { SettingsProvider } from "./features/settings/SettingsDialog"
import { configureExcalidrawAssets } from "./features/drawings/assets.ts"
import { EMBED_BASE, embedded, framed, requestedScheme, sitePath } from "./features/embed/mode"
import { loadEmbedRoot } from "./features/embed/load"
import "./index.css"

// /embed opened on its own, outside a panel: the same page on the site, and nothing starts here.
// Only ever a page on this site: anywhere else, the site's home. A pass in the
// fragment was already removed (mode.ts), so it never travels with it.
const leaving = embedded && !framed()
if (leaving) {
  const { origin, pathname, search, hash } = window.location
  const target = new URL(`${sitePath(pathname)}${search}${hash}`, origin)
  window.location.replace(target.origin === origin ? target.href : "/")
}

configureExcalidrawAssets()

// The page never zooms on phones and tablets (docs/architecture.md). iOS Safari
// ignores the viewport's maximum-scale for pinches, so its page-level gesture
// events are cancelled. Only the default is prevented, never propagation:
// Excalidraw listens for them on the document too, and zooms the canvas itself.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

/** A page whose code is still downloading. In a panel it fills the space under the panel's bar. */
function PendingPage() {
  return <PageLoading className={embedded ? "min-h-full" : undefined} />
}

// In a panel the app runs under /embed, so its routes and links stay as they are.
// A link to a page whose code has not loaded: the page being left takes no
// input from the start (routes/__root.tsx), and the loading state replaces it
// once the wait passes 100 ms, for at least 300 ms, so a page whose code has
// loaded never flashes it and a slow one never flickers.
const router = createRouter({
  routeTree,
  basepath: embedded ? EMBED_BASE : undefined,
  defaultPendingComponent: PendingPage,
  defaultPendingMs: 100,
  defaultPendingMinMs: 300,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

// In a panel, light or dark is the panel's (`?theme=`, then its messages), and nothing is kept.
const panelAppearance: { mode: ColorMode; persist: boolean } | undefined = embedded
  ? { mode: requestedScheme(window.location.search) ?? "system", persist: false }
  : undefined

// index.html's shell stays on screen until the first page's code has loaded
// (in a panel, the embed's chunk too), so the app replaces it with that page,
// never with a blank one. A failed load renders anyway, and the router shows
// the error.
if (!leaving) void Promise.all([router.load().catch(() => {}), embedded ? loadEmbedRoot().catch(() => {}) : null])
  .then(() =>
    createRoot(root).render(
      <StrictMode>
        <AppearanceProvider {...panelAppearance}>
          <SettingsProvider>
            <RouterProvider router={router} />
          </SettingsProvider>
        </AppearanceProvider>
      </StrictMode>,
    ),
  )
