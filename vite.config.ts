import path from "node:path"
import { defineConfig, normalizePath, type Rolldown } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import { VitePWA } from "vite-plugin-pwa"
import { bundleVisualizer } from "./vite-plugins/bundle-visualizer.ts"
import { excalidrawSubsetWorker } from "./vite-plugins/excalidraw-subset-worker.ts"
import { monacoLanguageServices } from "./vite-plugins/monaco-language-services.ts"
import { nativeFontAssets } from "./vite-plugins/native-font-assets.ts"
import { previewFrame } from "./vite-plugins/preview-frame.ts"
import { thirdPartyNotices } from "./vite-plugins/third-party-notices.ts"

const SRC = normalizePath(path.resolve(import.meta.dirname, "src")) + "/"

/**
 * The app's own modules only do something when what they export is used, so a
 * module nothing uses is left out of the build, also when a barrel
 * (`features/<feature>/index.ts`) re-exports it. Without this, a page that
 * imports one component from a barrel downloads every module behind it. The
 * entry is the exception: it runs code on import. CSS, and packages, keep
 * their own declarations (`undefined` falls back to their package.json).
 */
function appModuleSideEffects(id: string): boolean | undefined {
  if (!id.startsWith(SRC) || !/\.tsx?$/.test(id)) return undefined
  return id === `${SRC}main.tsx`
}

/**
 * App modules (under src/) that every page loads and that import app chunks
 * lazily (`import()`, `React.lazy`), so their code names those chunks' files.
 * They stay out of the shared `app` chunk below. Add a module here when it
 * starts doing that: left out, everything still works, but each change to the
 * lazy chunk renames `app` and every chunk that imports it.
 */
const LOADS_CHUNKS = /^(?:main\.tsx|routeTree\.gen\.ts|routes\/|features\/workbench\/load\.ts)/

const UI = "@base-ui|@floating-ui|@radix-ui|cmdk|tabbable|react-resizable-panels|clsx|tailwind-merge|class-variance-authority"

const pkg = (names: string) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${names})[\\\\/]`)

/** A library's code that the first page needs, in one chunk named after it. */
const firstPaint = (name: string, test: RegExp): Rolldown.CodeSplittingGroup => ({ name, test, tags: ["$initial"], priority: 20 })

/**
 * A library the app loads later. Its code splits by what loads it
 * (`entriesAware`), so a part that only one lazy feature uses stays with that
 * feature and never joins an earlier load.
 */
const later = (name: string, test: RegExp): Rolldown.CodeSplittingGroup => ({ name, test, entriesAware: true, priority: 10 })

/**
 * Libraries in chunks of their own, named after them, so a deploy that only
 * changes the app's code leaves their files (and their hashes) as they were:
 * the service worker's update then downloads the app's changed chunks, not
 * Monaco or the preview frame again, and `bun run report:bundle` reads by
 * library. Only code that already loads together shares a chunk; the rest
 * stays where rolldown puts it.
 */
const LIBRARY_CHUNKS: Rolldown.CodeSplittingGroup[] = [
  // Every lazy import goes through this helper. On its own, so no library
  // group takes it along as a dependency and joins the first paint with it.
  { name: "preload-helper", test: /^\0vite\/preload-helper/, priority: 40 },
  { ...firstPaint("react", pkg("react|react-dom|scheduler")), priority: 30 },
  firstPaint("router", pkg("@tanstack")),
  firstPaint("supabase", pkg("@supabase")),
  firstPaint("ui", pkg(`${UI}|lucide-react`)),
  firstPaint("zod", pkg("zod")),
  // The rest of the component libraries, with their dependencies, by what
  // loads them. Excalidraw shares Radix code with the command palette; in an
  // app chunk, Excalidraw's chunk would import it from there and change with
  // every deploy.
  { ...later("ui", pkg(UI)), priority: 15 },
  // Not the language tokenizers: Monaco loads each one the first time its
  // language shows (code blocks in a note too), as files of their own.
  later("monaco", /[\\/]node_modules[\\/]monaco-editor[\\/](?!esm[\\/]vs[\\/]languages[\\/]definitions[\\/][^\\/]+[\\/](?!register\.js$))/),
  later("prettier", pkg("prettier")),
  later("prosemirror", pkg("prosemirror-[\\w-]+")),
  // The MDX compiler, with its parsers (micromark, acorn) as dependencies.
  later("mdx", pkg("@mdx-js|remark-[\\w-]+|micromark[\\w-]*|mdast-util-[\\w-]+|unified")),
  // The note preview frame's own build, as one string (vite-plugins/preview-frame.ts).
  later("preview-frame", /^\0virtual:preview-frame$/),
  // The app's own code that every page starts with, apart from the modules
  // that import lazy chunks by name (the entry, the routes, the workbench
  // loader): a change to a lazy chunk then renames only those, not every
  // chunk that uses shared app code.
  { name: "app", test: (id) => id.startsWith(SRC) && /\.tsx?$/.test(id) && !LOADS_CHUNKS.test(id.slice(SRC.length)), tags: ["$initial"], priority: 5 },
]

/**
 * A library group's files are named after the library alone: split by what
 * loads it (`entriesAware`), its chunk name lists every chunk that loads it
 * ("ui~sign-in~index~..."). Excalidraw's translations go in a folder of
 * their own, so the precache can leave out the ones the app never loads (see
 * `globIgnores`).
 */
const groupName = (name: string | undefined) => (name?.includes("~") ? name.split("~")[0] : "[name]")

function chunkFileName(chunk: Rolldown.PreRenderedChunk): string {
  if (/[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]locales[\\/]/.test(chunk.facadeModuleId ?? "")) return "assets/excalidraw-locales/[name]-[hash].js"
  return `assets/${groupName(chunk.name)}-[hash].js`
}

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
    // The editors never start these services' workers (src/features/source/SourceEditor.tsx).
    monacoLanguageServices({ exclude: ["typescript", "css", "html"] }),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Before thirdPartyNotices, so the frame's licenses are merged first.
    previewFrame(),
    // The generated service worker ships these Workbox modules in its own
    // workbox-*.js file, outside the bundle (checked by offline.spec.ts).
    thirdPartyNotices({
      packages: ["workbox-cacheable-response", "workbox-core", "workbox-precaching", "workbox-routing", "workbox-strategies"],
    }),
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
        // What the app can need with no network: every chunk including lazy
        // ones, styles, workers, the fonts of the app's own interface, the
        // preview frame (inlined in a chunk), the D2 compiler, wasm and the
        // license texts. Not Excalidraw's drawing fonts (about 13 MB, most
        // of it CJK subsets): they are cached when a drawing first shows
        // them, below. `_headers` is Cloudflare's configuration, not a file
        // it serves, and the plugin lists the web manifest itself.
        globPatterns: ["**/*"],
        // Excalidraw's CJK drawing font (Xiaolai, 13 MB in 209 subsets) is
        // cached on first use instead; its other drawing fonts (0.5 MB) are
        // precached, so new drawings have their default font offline.
        // Excalidraw's translations other than English are left out too: the
        // app never sets its language (langCode), so they never load. If it
        // ever does, cache them on first use like the drawing fonts.
        globIgnores: ["_headers", "manifest.webmanifest", "excalidraw-assets/fonts/Xiaolai/**", "assets/excalidraw-locales/!(en-*)"],
        // Workbox skips files over 2 MiB by default, and the largest chunks
        // are bigger. tests/browser/offline.spec.ts checks nothing is skipped.
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: "index.html",
        // The first version takes over the page that installed it, so lazy
        // chunks load from the cache if the connection drops. Later versions
        // wait: skipWaiting stays off until the person chooses the update.
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Font files from this site that are not precached are kept the first
        // time they load. Only same-origin requests: Supabase, and every other
        // origin, never pass through a cache.
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) => sameOrigin && /\.(?:woff2?|ttf|otf)$/.test(url.pathname),
            handler: "CacheFirst",
            options: { cacheName: "fonts", cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
    // Only in `bun run build:visualize` (see the plugin).
    bundleVisualizer(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Workers are ES modules. Firefox (at least the build the browser tests
  // use) crashes the tab when a classic worker is stopped while it is still
  // starting, as when a note closes right after it opens; module workers don't.
  worker: { format: "es" },
  // The minifier drops license comments, so the build lists the licenses of
  // the third-party code it includes in one file, served at this path.
  build: {
    license: { fileName: "third-party-notices.txt" },
    rolldownOptions: {
      treeshake: { moduleSideEffects: appModuleSideEffects },
      output: {
        codeSplitting: { groups: LIBRARY_CHUNKS },
        chunkFileNames: chunkFileName,
        assetFileNames: (asset) => `assets/${groupName(asset.names[0])}-[hash][extname]`,
      },
    },
  },
})
