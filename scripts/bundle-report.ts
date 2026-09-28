// What each page downloads before it can show anything, and what each feature
// adds the first time it is used, from the visualize build: raw, gzip and
// brotli bytes of the files themselves. Also the largest packages and the
// chunks they land in, and the service worker's precache.
//
//   bun run build:visualize && bun run report:bundle [dir]
//
// `dir` defaults to dist-visualize. The chunk graph comes from the build's
// manifest (app/.vite/manifest.json); which chunk a module lands in comes from
// the visualizer's data (stats.json). A module's size is its share of its
// chunk, scaled from the visualizer's pre-minification lengths, so it is an
// estimate; chunk and file sizes are exact.
//
// Pages and features name the source modules that start them. When one is
// renamed, the report stops and says which, so update the lists below.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

type ManifestChunk = {
  file: string
  src?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
  assets?: string[]
}
type Manifest = Record<string, ManifestChunk>

/** rollup-plugin-visualizer's raw data (template "raw-data"), the parts used here. */
type Stats = {
  nodeParts: Record<string, { renderedLength: number; gzipLength: number; brotliLength: number; metaUid: string }>
  nodeMetas: Record<string, { id: string; moduleParts: Record<string, string> }>
}

type Match = string | RegExp

/** A page: the route chunks it loads on top of the entry before the first paint. */
type Page = { name: string; start: Match[]; note?: string }

/** A feature on the project page: the chunks and workers its first use loads, and the modules that make it up. */
type Feature = { name: string; start: Match[]; workers?: RegExp[]; modules: RegExp[]; note?: string }

// Every page loads the entry, and the service worker's registration imports
// workbox-window once the app has started.
const EVERY_PAGE: Match[] = ["index.html", /^node_modules\/workbox-window\//]

const PAGES: Page[] = [
  { name: "Home, signed out (/)", start: ["src/routes/index.tsx?tsr-split=component"] },
  { name: "Sign in (/sign-in)", start: ["src/routes/sign-in.tsx?tsr-split=component"] },
  { name: "Style guide (/style-guide)", start: ["src/routes/style-guide.tsx?tsr-split=component"] },
  {
    name: "Project page (/projects/<id>)",
    start: ["src/routes/projects.$projectId.tsx?tsr-split=component", "src/features/workbench/WorkspaceWorkbench.tsx"],
    note: "the route's loader starts the workbench chunk",
  },
]
const PROJECT_PAGE = PAGES[3]

const FEATURES: Feature[] = [
  {
    name: "A note's Source view (Monaco)",
    start: [
      "src/features/source/MonacoSourceEditor.tsx",
      /^node_modules\/monaco-editor\/esm\/vs\/languages\/definitions\/markdown\//,
      /^node_modules\/monaco-editor\/esm\/vs\/languages\/definitions\/mdx\//,
    ],
    workers: [/^editor\.worker-/],
    modules: [/node_modules\/monaco-editor\//, /node_modules\/prettier\//, /src\/features\/source\//],
    note: "Markdown and MDX tokenizers and the editor worker; JSON files also start json.worker",
  },
  {
    name: "A note's Rendered view (the frame)",
    start: ["src/features/rendered/RenderedEditor.tsx"],
    modules: [/virtual:preview-frame$/, /src\/features\/rendered\//, /src\/preview\//, /node_modules\/prosemirror-/, /node_modules\/@mdx-js\//],
    note: "the frame's own code (React, MDX runtime, ProseMirror) is one string inside a chunk; charts and code highlighting load on their own, below",
  },
  {
    name: "A note's compile check (the MDX compiler)",
    start: ["src/features/rendered/instrumentation.ts"],
    modules: [/node_modules\/(@mdx-js|micromark[\w-]*|mdast-util-[\w-]+|remark-[\w-]+|unified|acorn[\w-]*)\//, /src\/features\/rendered\/instrumentation\.ts$/, /src\/features\/document\/componentModules\.ts$/],
    note: "the first note that opens, in Source or Rendered, loads it",
  },
  {
    name: "A chart in a note (the frame's charts)",
    start: ["virtual:preview-frame/charts"],
    modules: [/virtual:preview-frame\/charts$/],
    note: "sent into the note's frame the first time it shows a chart",
  },
  {
    name: "A code block in a note (the frame's highlighter)",
    start: ["virtual:preview-frame/highlighter"],
    modules: [/virtual:preview-frame\/highlighter$/],
    note: "sent into the note's frame the first time it shows a code block with a language",
  },
  {
    name: "A drawing (Excalidraw)",
    start: ["src/features/workbench/DrawingView.tsx", /^node_modules\/@excalidraw\/excalidraw\/dist\/prod\/index\.js$/, /^node_modules\/@excalidraw\/excalidraw\/dist\/prod\/locales\/en-/],
    modules: [/node_modules\/@excalidraw\//, /src\/features\/drawings\//, /src\/features\/workbench\/DrawingView\./],
    note: "the drawing view, then Excalidraw when the canvas shows; plus its drawing fonts from /excalidraw-assets/ and the font subset worker when text is exported",
  },
  {
    name: "A diagram (D2)",
    start: ["src/features/workbench/DiagramView.tsx", /^node_modules\/@terrastruct\/d2\//, "src/features/structured/native-font-ttf.json"],
    modules: [/node_modules\/@terrastruct\//, /src\/features\/structured\//, /src\/features\/workbench\/(DiagramView|diagramArtifact|diagramEmbed)\./],
    note: "the diagram view, then D2 and its measuring font on the first compile; Excalidraw, as for a drawing, when the canvas shows",
  },
  { name: "The command palette", start: [], modules: [/node_modules\/cmdk\//, /QuickOpen\.tsx$/, /FileSearch\.tsx$/, /contentSearch\.ts$/] },
  { name: "Settings", start: [], modules: [/src\/features\/settings\//, /src\/features\/appearance\/.*\.tsx$/] },
  { name: "Comments", start: [], modules: [/src\/features\/comments\//] },
]

const dir = path.resolve(process.argv[2] ?? "dist-visualize")
const app = path.join(dir, "app")
const manifestPath = path.join(app, ".vite/manifest.json")
if (!existsSync(manifestPath)) {
  console.error(`No build manifest at ${manifestPath}. Run \`bun run build:visualize\` first.`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
const statsPath = path.join(dir, "stats.json")
const stats = existsSync(statsPath) ? (JSON.parse(readFileSync(statsPath, "utf8")) as Stats) : null

// Sizes ------------------------------------------------------------------

type Size = { raw: number; gzip: number; brotli: number }
const zero = (): Size => ({ raw: 0, gzip: 0, brotli: 0 })
const add = (a: Size, b: Size): Size => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli })

const sizes = new Map<string, Size>()
/** A built file's size, as served and compressed (gzip level 9, brotli quality 11). */
function sizeOf(file: string): Size {
  let size = sizes.get(file)
  if (!size) {
    const bytes = readFileSync(path.join(app, file))
    size = {
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
    }
    sizes.set(file, size)
  }
  return size
}

const kB = (bytes: number) => `${(bytes / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kB`
const cells = (size: Size) => [kB(size.raw), kB(size.gzip), kB(size.brotli)]

function table(rows: string[][], header = ["", "raw", "gzip", "brotli"]) {
  const all = [header, ...rows]
  const widths = header.map((_, column) => Math.max(...all.map((row) => row[column]?.length ?? 0)))
  const numeric = (column: number) => ["raw", "gzip", "brotli"].includes(header[column])
  for (const row of all) console.log(`  ${row.map((cell, column) => (numeric(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join("   ").trimEnd()}`)
}

// The chunk graph ---------------------------------------------------------

/** The one manifest key a match names; stops the report when it names none or several. */
function keyFor(match: Match): string {
  const keys = Object.keys(manifest).filter((key) => (typeof match === "string" ? key === match : match.test(key)))
  if (keys.length !== 1) {
    console.error(`${keys.length === 0 ? "No" : "More than one"} chunk in the manifest for ${match}${keys.length ? `: ${keys.join(", ")}` : ""}. Update scripts/bundle-report.ts.`)
    process.exit(1)
  }
  return keys[0]
}

/** The manifest keys loaded with these: they and everything they import statically. */
function withImports(keys: string[]): Set<string> {
  const seen = new Set<string>()
  const visit = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    for (const next of manifest[key].imports ?? []) visit(next)
  }
  keys.forEach(visit)
  return seen
}

type Files = { js: string[]; css: string[] }
function filesOf(keys: Set<string>): Files {
  const js = new Set<string>()
  const css = new Set<string>()
  for (const key of keys) {
    js.add(manifest[key].file)
    for (const sheet of manifest[key].css ?? []) css.add(sheet)
  }
  return { js: [...js], css: [...css] }
}

const total = (files: readonly string[]) => files.map(sizeOf).reduce(add, zero())

function printFiles(files: Files, extra: string[] = []) {
  const rows: string[][] = []
  for (const [label, list] of [["JS", [...files.js, ...extra]], ["CSS", files.css]] as const) {
    if (list.length === 0) continue
    rows.push([`${label}, ${list.length} file${list.length === 1 ? "" : "s"}`, ...cells(total(list))])
    for (const file of [...list].sort((a, b) => sizeOf(b).raw - sizeOf(a).raw)) rows.push([`  ${path.basename(file)}`, ...cells(sizeOf(file))])
  }
  table(rows)
}

// Modules ------------------------------------------------------------------

type ModuleSize = { id: string; chunk: string; size: Size }

/** Every module with its estimated share of its chunk's served size. */
function moduleSizes(): ModuleSize[] {
  if (!stats) return []
  const byChunk = new Map<string, Array<{ id: string; part: Stats["nodeParts"][string] }>>()
  for (const meta of Object.values(stats.nodeMetas)) {
    for (const [chunk, uid] of Object.entries(meta.moduleParts)) {
      const part = stats.nodeParts[uid]
      if (!part || !existsSync(path.join(app, chunk))) continue
      const list = byChunk.get(chunk) ?? []
      list.push({ id: meta.id, part })
      byChunk.set(chunk, list)
    }
  }
  const result: ModuleSize[] = []
  for (const [chunk, parts] of byChunk) {
    const actual = sizeOf(chunk)
    const sum = parts.reduce((acc, { part }) => ({ raw: acc.raw + part.renderedLength, gzip: acc.gzip + part.gzipLength, brotli: acc.brotli + part.brotliLength }), zero())
    const share = (value: number, of: number, served: number) => (of === 0 ? 0 : (value / of) * served)
    for (const { id, part } of parts) {
      result.push({
        id: id.replace(/^\0/, ""),
        chunk,
        size: {
          raw: share(part.renderedLength, sum.raw, actual.raw),
          gzip: share(part.gzipLength, sum.gzip, actual.gzip),
          brotli: share(part.brotliLength, sum.brotli, actual.brotli),
        },
      })
    }
  }
  return result
}

/** A module's package (`node_modules/<name>`) or, for the app's code, its folder. */
function groupOf(id: string): string {
  const inModules = id.lastIndexOf("node_modules/")
  if (inModules !== -1) {
    const [scope, name] = id.slice(inModules + "node_modules/".length).split("/")
    return scope.startsWith("@") ? `${scope}/${name}` : scope
  }
  const parts = id.replace(/^.*?\/src\//, "src/").split("?")[0].split("/")
  // A feature's subfolder (design-system/guide) is its own group.
  if (parts[0] === "src" && parts[1] === "features") return parts.slice(0, Math.min(parts.length - 1, 4)).join("/")
  if (parts[0] === "src") return parts.slice(0, Math.min(parts.length - 1, 2)).join("/") || parts.join("/")
  return parts.join("/")
}

const modules = moduleSizes()

/** The largest packages and app folders in these files, by estimated gzip size. */
function printParts(files: Set<string>, count = 8) {
  const groups = new Map<string, number>()
  for (const module of modules) if (files.has(module.chunk)) groups.set(groupOf(module.id), (groups.get(groupOf(module.id)) ?? 0) + module.size.gzip)
  const top = [...groups].sort(([, a], [, b]) => b - a).slice(0, count)
  if (top.length > 0) console.log(`  Largest parts (gzip): ${top.map(([name, gzip]) => `${name} ${kB(gzip)}`).join(", ")}`)
}

// The report -----------------------------------------------------------------

const everyPage = EVERY_PAGE.map(keyFor)
const pageKeys = new Map<Page, Set<string>>()

console.log(`Bundle report for ${path.relative(process.cwd(), app) || app}: sizes of the served files (gzip level 9, brotli quality 11).\n`)
console.log("First paint: what each page downloads before it can show anything\n")
for (const page of PAGES) {
  const keys = withImports([...everyPage, ...page.start.map(keyFor)])
  pageKeys.set(page, keys)
  console.log(`${page.name}${page.note ? ` (${page.note})` : ""}`)
  printFiles(filesOf(keys))
  printParts(new Set(filesOf(keys).js))
  console.log()
}

const baseKeys = pageKeys.get(PROJECT_PAGE) ?? new Set<string>()
const baseFiles = new Set([...filesOf(baseKeys).js, ...filesOf(baseKeys).css])
const assetFiles = readdirSync(path.join(app, "assets"))

console.log("Features: what the first use of each adds to the project page\n")
for (const feature of FEATURES) {
  console.log(`${feature.name}${feature.note ? ` (${feature.note})` : ""}`)
  const added = filesOf(withImports(feature.start.map(keyFor)))
  const workers = assetFiles.filter((file) => feature.workers?.some((pattern) => pattern.test(file))).map((file) => `assets/${file}`)
  const fresh = { js: added.js.filter((file) => !baseFiles.has(file)), css: added.css.filter((file) => !baseFiles.has(file)) }
  if (fresh.js.length + fresh.css.length + workers.length === 0) console.log("  Loads nothing more: its code is already in the project page's first load.")
  else printFiles(fresh, workers)
  const inFirstLoad = new Map<string, Size>()
  for (const module of modules) {
    if (!baseFiles.has(module.chunk) || !feature.modules.some((pattern) => pattern.test(module.id))) continue
    inFirstLoad.set(module.chunk, add(inFirstLoad.get(module.chunk) ?? zero(), module.size))
  }
  if (inFirstLoad.size > 0) {
    console.log("  Its code the project page already downloads first (estimated):")
    table(
      [...inFirstLoad].sort(([, a], [, b]) => b.raw - a.raw).map(([chunk, size]) => [`  in ${path.basename(chunk)}`, ...cells(size)]),
      ["", "raw", "gzip", "brotli"],
    )
  }
  console.log()
}

if (modules.length > 0) {
  console.log("Largest packages and app folders, and the chunks they land in (estimated)\n")
  const groups = new Map<string, { size: Size; chunks: Map<string, number> }>()
  for (const module of modules) {
    const group = groups.get(groupOf(module.id)) ?? { size: zero(), chunks: new Map<string, number>() }
    group.size = add(group.size, module.size)
    group.chunks.set(module.chunk, (group.chunks.get(module.chunk) ?? 0) + module.size.raw)
    groups.set(groupOf(module.id), group)
  }
  const rows = [...groups]
    .sort(([, a], [, b]) => b.size.raw - a.size.raw)
    .slice(0, 30)
    .map(([name, { size, chunks }]) => {
      const where = [...chunks].sort(([, a], [, b]) => b - a).map(([chunk]) => path.basename(chunk))
      return [name, ...cells(size), `${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}`]
    })
  table(rows, ["", "raw", "gzip", "brotli", "chunks"])
  console.log()
}

const sw = path.join(app, "sw.js")
if (existsSync(sw)) {
  const urls = [...readFileSync(sw, "utf8").matchAll(/\{url:"([^"]+)",revision:/g)].map(([, url]) => url)
  const precached = urls.filter((url) => existsSync(path.join(app, url))).map((url) => ({ url, size: readFileSync(path.join(app, url)).length }))
  const bytes = (predicate: (url: string) => boolean) => precached.filter(({ url }) => predicate(url)).reduce((sum, { size }) => sum + size, 0)
  console.log("Service worker precache (downloaded in the background on a first visit)")
  table(
    [
      [`all, ${precached.length} files`, kB(bytes(() => true))],
      ["  JavaScript", kB(bytes((url) => url.endsWith(".js")))],
      ["  CSS", kB(bytes((url) => url.endsWith(".css")))],
      ["  fonts", kB(bytes((url) => /\.(woff2?|ttf|otf)$/.test(url)))],
      ["  other", kB(bytes((url) => !/\.(js|css|woff2?|ttf|otf)$/.test(url)))],
    ],
    ["", "raw"],
  )
}
