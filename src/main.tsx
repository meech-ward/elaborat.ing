import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { AppearanceProvider } from "./features/appearance"
import { SettingsProvider } from "./features/settings/SettingsDialog"
import { configureExcalidrawAssets } from "./features/drawings/assets.ts"
import "./index.css"

configureExcalidrawAssets()

const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <StrictMode>
    <AppearanceProvider>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </AppearanceProvider>
  </StrictMode>,
)
