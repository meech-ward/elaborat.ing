import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import { excalidrawSubsetWorker } from "./vite-plugins/excalidraw-subset-worker.ts"
import { nativeFontAssets } from "./vite-plugins/native-font-assets.ts"
import { previewFrame } from "./vite-plugins/preview-frame.ts"
import { thirdPartyNotices } from "./vite-plugins/third-party-notices.ts"

// The TanStack Router plugin must come before react().
// React Compiler uses the stable documented Babel preset; plugin-react's
// `compiler: true` option is experimental.
// Excalidraw needs its fonts served from this site and its font-subset
// worker built as a separate worker graph (see each plugin).
export default defineConfig({
  plugins: [
    nativeFontAssets(),
    excalidrawSubsetWorker(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Before thirdPartyNotices, so the frame's licenses are merged first.
    previewFrame(),
    thirdPartyNotices(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The minifier drops license comments, so the build lists the licenses of
  // the third-party code it includes in one file, served at this path.
  build: { license: { fileName: "third-party-notices.txt" } },
})
