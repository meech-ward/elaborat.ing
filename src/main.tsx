import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { AppearanceProvider } from "./features/appearance"
import { SettingsProvider } from "./features/settings/SettingsDialog"
import { configureExcalidrawAssets } from "./features/drawings/assets.ts"
import "./index.css"

configureExcalidrawAssets()

// The page never zooms on phones and tablets (docs/architecture.md). iOS Safari
// ignores the viewport's maximum-scale for pinches, so its page-level gesture
// events are cancelled. Only the default is prevented, never propagation:
// Excalidraw listens for them on the document too, and zooms the canvas itself.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

// index.html's shell stays on screen until the first page's code has loaded,
// so the app replaces it with that page, never with a blank one. A failed
// load renders anyway, and the router shows the error.
void router
  .load()
  .catch(() => {})
  .then(() =>
    createRoot(root).render(
      <StrictMode>
        <AppearanceProvider>
          <SettingsProvider>
            <RouterProvider router={router} />
          </SettingsProvider>
        </AppearanceProvider>
      </StrictMode>,
    ),
  )
