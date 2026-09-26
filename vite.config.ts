import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import { VitePWA } from "vite-plugin-pwa"
import { excalidrawSubsetWorker } from "./vite-plugins/excalidraw-subset-worker.ts"
import { nativeFontAssets } from "./vite-plugins/native-font-assets.ts"
import { previewFrame } from "./vite-plugins/preview-frame.ts"
import { thirdPartyNotices } from "./vite-plugins/third-party-notices.ts"

// The TanStack Router plugin must come before react().
// React Compiler uses the stable documented Babel preset; plugin-react's
// `compiler: true` option is experimental.
// Excalidraw needs its fonts served from this site and its font-subset
// worker built as a separate worker graph (see each plugin).
// The service worker lets the app start with no network (see "Offline start"
// in docs/architecture.md).
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
    // The generated service worker ships these Workbox modules in its own
    // workbox-*.js file, outside the bundle (checked by offline.spec.ts).
    thirdPartyNotices({ packages: ["workbox-core", "workbox-precaching", "workbox-routing", "workbox-strategies"] }),
    VitePWA({
      // A new version waits until the person chooses "Update ready"
      // (src/features/updates). The component registers the worker.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "elaborat.ing",
        short_name: "elaborat.ing",
        description: "Notes, drawings and diagrams in one project.",
        start_url: "/",
        display: "standalone",
        background_color: "#191c22",
        theme_color: "#11141a",
      },
      workbox: {
        // Everything the build ships, so the app can start with no network:
        // every chunk including lazy ones, styles, workers, fonts, the
        // preview frame (inlined in a chunk), wasm and the license texts.
        // `_headers` is Cloudflare's configuration, not a file it serves, and
        // the plugin lists the web manifest itself.
        globPatterns: ["**/*"],
        globIgnores: ["_headers", "manifest.webmanifest"],
        // Workbox skips files over 2 MiB by default, and the largest chunks
        // are bigger. tests/browser/offline.spec.ts checks nothing is skipped.
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: "index.html",
        // The first version takes over the page that installed it, so lazy
        // chunks load from the cache if the connection drops. Later versions
        // wait: skipWaiting stays off until the person chooses the update.
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // No runtimeCaching: requests to Supabase, and to every other origin,
        // never pass through a cache.
      },
    }),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // The minifier drops license comments, so the build lists the licenses of
  // the third-party code it includes in one file, served at this path.
  build: { license: { fileName: "third-party-notices.txt" } },
})
