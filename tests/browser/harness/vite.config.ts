import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { excalidrawSubsetWorker } from "../../../vite-plugins/excalidraw-subset-worker.ts"
import { nativeFontAssets } from "../../../vite-plugins/native-font-assets.ts"
import { previewFrame } from "../../../vite-plugins/preview-frame.ts"

// The same plugins and React setup as the app's vite.config.ts, for two
// test-only pages: a drawing (index.html) and a rendered note (rendered.html).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    nativeFontAssets(),
    excalidrawSubsetWorker(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    previewFrame(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../../src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    license: { fileName: "third-party-notices.txt" },
    rolldownOptions: {
      input: {
        index: path.join(import.meta.dirname, "index.html"),
        rendered: path.join(import.meta.dirname, "rendered.html"),
      },
    },
  },
})
