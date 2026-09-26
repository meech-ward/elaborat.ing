import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import { excalidrawSubsetWorker } from "../../../vite-plugins/excalidraw-subset-worker.ts"
import { nativeFontAssets } from "../../../vite-plugins/native-font-assets.ts"

// The same Excalidraw plugins and React setup as the app's vite.config.ts.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [nativeFontAssets(), excalidrawSubsetWorker(), react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../../src") } },
  build: { outDir: "dist", emptyOutDir: true },
})
