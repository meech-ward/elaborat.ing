// Builds the chat card: the MCP Apps view of show_file and preview_component.
//
// The view is a small shell (src/chat-card/main.tsx: React, the host bridge,
// and the card with the server's HTML and drawings), built into one script
// and one stylesheet that the MCP server inlines into the view
// (supabase/functions/mcp-server/tools/cardEditorScript.ts). The rest goes in
// public/chat-card/, which the app's deploy serves at
// https://elaborat.ing/chat-card/, and loads when it is needed:
//
// - the app's fonts, which the card adds once the host has answered
// - editor: the note editor, when Edit is pressed (src/chat-card/lazy/editor.ts)
// - live: a note, drawing or diagram shown while the agent writes it, a new
//   one (create_and_show) or a change to one (update_and_show)
//   (src/chat-card/lazy/live.ts), drawn with the MCP server's own renderers
// - highlight: the app's code highlighter, after a note with a code block shows
// - compile: the component compiler, for a note with components or a component file
// - frame: the component preview frame's runtime and stylesheet, which the
//   frame itself loads; it loads the charts' library only for a note with a chart
// - diagram: the app's D2 code, for a D2 diagram the app has not drawn from
//   its source yet (src/chat-card/lazy/diagram.ts), with D2's engine, which
//   runs in a worker of the card's own from two classic scripts: D2's files,
//   with its wasm brotli-compressed as base64 (d2-engine), and the worker's
//   code (d2-worker, src/chat-card/diagram/engine.worker.ts)
//
// The modules are ES modules with content-hashed names, and the shell loads
// them with import(). The view declares their origin in its CSP
// (fileView.ts). A host that does not allow it blocks them, and the card
// shows the server's HTML, read-only, in the host's or the system's fonts.
//
// Both are committed: the Edge Functions deploy without building the app, and
// the app deploys separately, so the files of the last several builds stay
// (builds.json, vite-plugins/chat-card-builds.ts), for a view whose function
// is not deployed yet or that a host cached. Run it after changing the card or
// the app modules it uses, and give the view a new ui:// URI:
//
//   bun run build:chat-card               writes both, and prints their sizes
//   bun run build:chat-card --visualize   also writes treemaps to dist-visualize/chat-card/
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from "node:zlib"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { visualizer } from "rollup-plugin-visualizer"
import { build, normalizePath, type PluginOption } from "vite"
import { keepCardBuilds, listedCardBuilds } from "../vite-plugins/chat-card-builds"
import { npmSpecifiers as npmSpecifierPlugin } from "../vite-plugins/npm-specifiers"
import { assertCardModulePolicy } from "../vite-plugins/card-module-policy"
import { COLOR_TOKEN_KEYS } from "../src/features/appearance/paletteCss"
import { DEFAULT_THEME, getAppearanceTokens, tokenProperty, type ColorScheme } from "../src/features/appearance/tokens"
import { beforeDarkFilter } from "../src/features/drawings/presentation"

const REPO = path.resolve(import.meta.dirname, "..")
const SRC = normalizePath(path.join(REPO, "src")) + "/"
const ENTRY = path.join(REPO, "src/chat-card/main.tsx")
const MODULE_ENTRIES = {
  editor: path.join(REPO, "src/chat-card/lazy/editor.ts"),
  live: path.join(REPO, "src/chat-card/lazy/live.ts"),
  compile: path.join(REPO, "src/chat-card/lazy/compile.ts"),
  highlight: path.join(REPO, "src/chat-card/lazy/highlight.ts"),
  diagram: path.join(REPO, "src/chat-card/lazy/diagram.ts"),
  frame: path.join(REPO, "src/chat-card/preview/runtime.tsx"),
}
/** The worker that runs D2's engine for the card, built as a classic script. */
const ENGINE_WORKER = path.join(REPO, "src/chat-card/diagram/engine.worker.ts")
/** D2 in the card's build: the card's engine, as the app's build has its own (vite-plugins/d2-engine.ts). */
const CARD_D2 = path.join(REPO, "src/chat-card/diagram/d2Engine.ts")
const OUT = path.join(REPO, "supabase/functions/mcp-server/tools/cardEditorScript.ts")
const MODULES_DIR = path.join(REPO, "public/chat-card")
const BUILDS = path.join(MODULES_DIR, "builds.json")
/** Where the app's deploy serves public/chat-card. The view's CSP declares this origin (fileView.ts). */
const MODULES_URL = "https://elaborat.ing/chat-card/"
const VISUALIZE = process.argv.includes("--visualize")

// The card's fonts, as files beside the modules: the app's two (their Latin
// subsets) and Excalifont's Latin subset (U+20-7E and the Latin-1 letters),
// the font the server names first for text in drawings. Excalifont's name is
// the pinned Excalidraw's; the build stops here if an upgrade renames it.
const excalidraw = path.dirname(createRequire(path.join(REPO, "package.json")).resolve("@excalidraw/excalidraw"))
const FONTS: Array<{ family: string; weight: string; name: string; file: string }> = [
  {
    family: "Space Grotesk Variable",
    weight: "300 700",
    name: "space-grotesk-latin",
    file: path.join(REPO, "node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2"),
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    name: "jetbrains-mono-latin",
    file: path.join(REPO, "node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
  },
  {
    family: "Excalifont",
    weight: "400",
    name: "excalifont-latin",
    file: path.join(excalidraw, "fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"),
  },
]
const hashOf = (content: string | Uint8Array) => createHash("sha256").update(content).digest("base64url").slice(0, 8)
const fonts = FONTS.map((font) => {
  const bytes = readFileSync(font.file)
  return { ...font, bytes, fileName: `${font.name}-${hashOf(bytes)}.woff2` }
})

// The MCP server's modules, which the live view shares, import their packages
// as Deno does; each resolves to the app's own pinned copy.
const npmSpecifiers = npmSpecifierPlugin(REPO)

type OutputChunk = { type: "chunk"; fileName: string; code: string; isEntry: boolean; name: string; imports: string[]; dynamicImports: string[] }
type OutputAsset = { type: "asset"; fileName: string; source: string | Uint8Array }
type Output = { output: Array<OutputChunk | OutputAsset> }

/**
 * The app's own modules only do something when what they export is used (as
 * in vite.config.ts), so the shell leaves out what only the modules use. The
 * exceptions run code on import: the entries, and Zod's jitless setting.
 */
function appModuleSideEffects(id: string): boolean | undefined {
  if (!id.startsWith(SRC) || !/\.tsx?$/.test(id)) return undefined
  return id === `${SRC}chat-card/main.tsx` || id === `${SRC}chat-card/jitless.ts` || id === `${SRC}chat-card/diagram/engine.worker.ts`
}

const visualize = (name: string): PluginOption[] =>
  VISUALIZE
    ? (["html", "json"] as const).map((kind) =>
        visualizer({
          filename: path.join(REPO, `dist-visualize/chat-card/${name}.${kind}`),
          template: kind === "html" ? "treemap" : "raw-data",
          title: `elaborat.ing chat card: ${name}`,
          gzipSize: true,
          brotliSize: true,
        }) as PluginOption,
      )
    : []

const textOf = (source: string | Uint8Array) => (typeof source === "string" ? source : new TextDecoder().decode(source))

async function run(entry: string | Record<string, string>, name: string, format: "iife" | "es", define: Record<string, string>) {
  const result = (await build({
    configFile: false,
    root: REPO,
    mode: "production",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), ...define },
    resolve: {
      alias: [
        { find: /^@terrastruct\/d2$/, replacement: CARD_D2 },
        { find: "@", replacement: path.join(REPO, "src") },
      ],
    },
    plugins: [npmSpecifiers, react(), tailwindcss(), ...visualize(name)],
    build: {
      write: false,
      minify: true,
      cssMinify: true,
      lib: { entry, formats: [format], name: "elaboratingChatCard", fileName: () => `${name}.js`, cssFileName: name },
      rolldownOptions: {
        treeshake: { moduleSideEffects: appModuleSideEffects },
        // Library builds keep an ES module's whitespace and comments; these are served to browsers, not bundlers.
        output: format === "es" ? { entryFileNames: "[name]-[hash].js", chunkFileNames: "[name]-[hash].js", minify: true, comments: false } : {},
      },
    },
  })) as Output | Output[]
  return (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
}

// The default palette in light and dark: dark when the host says so, and
// before it does, whatever the device uses. A diagram's fills go in as the
// app's canvas takes them: through the dark filter the drawings get in dark.
const scheme = (value: ColorScheme) => {
  const tokens = getAppearanceTokens({ theme: DEFAULT_THEME, scheme: value })
  const shown = value === "dark" ? beforeDarkFilter : (color: string) => color
  return [
    ...COLOR_TOKEN_KEYS.map((key) => `${tokenProperty(key)}:${tokens[key]}`),
    `--card-d2-fill:${shown(tokens.d2Fill)}`,
    `--card-d2-fill2:${shown(tokens.d2Fill2)}`,
    `color-scheme:${value}`,
  ].join(";")
}
const palette =
  `:root{${scheme("light")}}:root[data-scheme="dark"]{${scheme("dark")}}` +
  `@media (prefers-color-scheme:dark){:root:not([data-scheme]){${scheme("dark")}}}`

// D2's engine for the card's diagrams, as the two classic scripts its worker
// imports (src/chat-card/diagram/d2Engine.ts). The first is D2's own files,
// from the package's Node build (byte for byte the ones its browser build
// embeds: vite-plugins/d2-engine.ts): Go's wasm_exec.js, ELK and its setup,
// each run as the package runs them (a function called on the global
// scope), then the wasm, brotli-compressed at the highest quality, as base64.
// Compressing it takes about a minute, so a build keeps the engine script it
// finds in public/chat-card when that unpacks to the package's wasm, byte for
// byte. The second is the worker's own code (engine.worker.ts), which unpacks
// the wasm off the card's page, with the brotli decoder.
const d2Files = path.dirname(createRequire(path.join(REPO, "package.json")).resolve("@terrastruct/d2"))
const d2Version = JSON.parse(readFileSync(path.join(d2Files, "../../package.json"), "utf8")).version as string
const d2Wasm = readFileSync(path.join(d2Files, "d2.wasm"))
const runAsPackage = (file: string) => `(function(){${readFileSync(path.join(d2Files, file), "utf8")}\n}).call(globalThis);\n`
const engineHead =
  `// D2 ${d2Version} (https://github.com/terrastruct/d2/tree/master/d2js/js, MPL-2.0), with ELK (EPL-2.0) and Go's wasm_exec.js (BSD-3-Clause),\n` +
  "// for the elaborat.ing chat card's diagrams. Third-party licenses: https://elaborat.ing/third-party-notices.txt\n" +
  runAsPackage("wasm_exec.js") +
  runAsPackage("elk.js") +
  runAsPackage("setup.js") +
  `self.d2Wasm={size:${d2Wasm.length},brotli:"`
const engineTail = '"};\n'

/** The engine script whose wasm unpacks to the package's, already in public/chat-card; null for none. */
function builtEngine(): string | null {
  for (const name of existsSync(MODULES_DIR) ? readdirSync(MODULES_DIR) : []) {
    if (!/^d2-engine-[\w-]{8}\.js$/.test(name)) continue
    const text = readFileSync(path.join(MODULES_DIR, name), "utf8")
    if (!text.startsWith(engineHead) || !text.endsWith(engineTail)) continue
    try {
      if (brotliDecompressSync(Buffer.from(text.slice(engineHead.length, -engineTail.length), "base64")).equals(d2Wasm)) return text
    } catch {
      // Not brotli: made another way.
    }
  }
  return null
}

const engineScript =
  builtEngine() ??
  engineHead +
    brotliCompressSync(d2Wasm, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: d2Wasm.length },
    }).toString("base64") +
    engineTail
const engineFile = `d2-engine-${hashOf(engineScript)}.js`
const workerChunk = (await run(ENGINE_WORKER, "d2-worker", "iife", {})).find((item): item is OutputChunk => item.type === "chunk")
if (!workerChunk) throw new Error("The chat card's D2 engine worker built no script.")
const workerScript = "// The elaborat.ing chat card's D2 engine worker. Third-party licenses: https://elaborat.ing/third-party-notices.txt\n" + workerChunk.code
const workerFile = `d2-worker-${hashOf(workerScript)}.js`

// The modules next: the shell carries their addresses. None of them, and
// neither of D2's engine scripts, makes requests or evaluates strings: the
// card runs under the host's policy for the view, which may have no
// 'unsafe-eval' (the spec's default has none), and the frame's modules too.
// D2's engine itself is WebAssembly that runs ELK's JavaScript from strings,
// so it draws only where the host allows both, as ChatGPT does; elsewhere the
// card shows a diagram as the server sent it.
const modules = await run(MODULE_ENTRIES, "modules", "es", {
  CARD_D2_ENGINE: JSON.stringify([MODULES_URL + engineFile, MODULES_URL + workerFile]),
})
const chunks = modules.filter((item): item is OutputChunk => item.type === "chunk")
for (const [fileName, code] of [...chunks.map((chunk) => [chunk.fileName, chunk.code]), [engineFile, engineScript], [workerFile, workerScript]]) {
  assertCardModulePolicy(fileName, code)
}
// One stylesheet, the frame's (preview/runtime.css), with the palette first. Named by its content, like the scripts.
const sheets = modules.filter((item): item is OutputAsset => item.type === "asset" && item.fileName.endsWith(".css"))
if (sheets.length !== 1) throw new Error(`The chat card modules built ${sheets.length} stylesheets, not the frame's one.`)
const frameCss = palette + textOf(sheets[0].source).trim()
const frameStyle = `frame-${hashOf(frameCss)}.css`
const files = new Map<string, string | Uint8Array>([
  ...chunks.map((chunk) => [chunk.fileName, chunk.code] as const),
  [frameStyle, frameCss],
  ...fonts.map((font) => [font.fileName, font.bytes] as const),
  [engineFile, engineScript],
  [workerFile, workerScript],
])
const entryFile = (name: keyof typeof MODULE_ENTRIES) => {
  const chunk = chunks.find((item) => item.isEntry && item.name === name)
  if (!chunk) throw new Error(`The chat card modules have no ${name} entry.`)
  return chunk.fileName
}
const addresses = {
  editor: MODULES_URL + entryFile("editor"),
  live: MODULES_URL + entryFile("live"),
  compile: MODULES_URL + entryFile("compile"),
  highlight: MODULES_URL + entryFile("highlight"),
  diagram: MODULES_URL + entryFile("diagram"),
  frame: MODULES_URL + entryFile("frame"),
  frameStyle: MODULES_URL + frameStyle,
}

const shell = await run(ENTRY, "shell", "iife", {
  CARD_MODULES: JSON.stringify(addresses),
  CARD_FONT_FILES: JSON.stringify(fonts.map((font) => [font.family, MODULES_URL + font.fileName, font.weight])),
})
const script = shell.find((item) => item.type === "chunk")
const sheet = shell.find((item) => item.type === "asset" && item.fileName.endsWith(".css"))
if (!script || script.type !== "chunk") throw new Error("The chat card build produced no script.")
if (!sheet || sheet.type !== "asset") throw new Error("The chat card build produced no stylesheet.")
const css = palette + textOf(sheet.source).trim()
if (/<\/style/i.test(css)) throw new Error("The chat card stylesheet cannot be inlined.")

// The script goes inside a <script> element, where these would end it early.
const code = script.code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")
if (/<\/script|<!--/i.test(code)) throw new Error("The chat card script cannot be inlined.")

writeFileSync(
  OUT,
  "// Generated by `bun run build:chat-card` from src/chat-card. Do not edit.\n" +
    "// Third-party licenses: https://elaborat.ing/third-party-notices.txt\n" +
    `export const CARD_STYLE = ${JSON.stringify(css)}\n` +
    `export const CARD_SCRIPT = ${JSON.stringify(code)}\n`,
)

// The files, before the committed builds' in builds.json
// (vite-plugins/chat-card-builds.ts). A committed file an earlier build
// removed comes back from git. Without git (a copy of the repository), the
// files on disk count.
const committed = (): unknown => {
  try {
    return JSON.parse(execFileSync("git", ["show", "HEAD:public/chat-card/builds.json"], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString())
  } catch {
    return null
  }
}
const fromGit = committed()
const before = listedCardBuilds(fromGit ?? (existsSync(BUILDS) ? JSON.parse(readFileSync(BUILDS, "utf8")) : null))
keepCardBuilds(MODULES_DIR, files, before, fromGit ? (name) => execFileSync("git", ["show", `HEAD:public/chat-card/${name}`], { cwd: REPO }) : undefined)

// What each step downloads: the view itself, then each module with the chunks it imports.
const size = (text: string | Uint8Array) => {
  const bytes = Buffer.from(text)
  const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`.padStart(10)
  return `${kb(bytes.length)} ${kb(gzipSync(bytes, { level: 9 }).length)} ${kb(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length)}`
}
const graph = (file: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const next of chunks.find((chunk) => chunk.fileName === file)?.imports ?? []) graph(next, seen)
  return seen
}
const frameFiles = graph(entryFile("frame"))
const later = (files: Set<string>) => [...files].flatMap((file) => chunks.find((chunk) => chunk.fileName === file)?.dynamicImports ?? [])
const charts = later(frameFiles)
// A diagram: the module, the parts it loads to compile (the engine's page side, the measuring font), and the engine's scripts.
const diagramFiles = graph(entryFile("diagram"))
for (const file of later(diagramFiles)) graph(file, diagramFiles)
const loads = (list: Iterable<string>) => Buffer.concat([...list].map((file) => Buffer.from(files.get(file) ?? "")))
const lines: Array<[string, string | Uint8Array]> = [
  ["The view (inline script and style)", code + css],
  ["Its fonts (woff2)", loads(fonts.map((font) => font.fileName))],
  ["Edit: the editor", loads(graph(entryFile("editor")))],
  ["Live: a file shown as it is written", loads(graph(entryFile("live")))],
  ["Code: the highlighter", loads(graph(entryFile("highlight")))],
  ["Components: compiler", loads(graph(entryFile("compile")))],
  ["Components: the frame", loads([...frameFiles, frameStyle])],
  ["A chart in the note", loads(new Set(charts.flatMap((file) => [...graph(file)]).filter((file) => !frameFiles.has(file))))],
  ["A diagram: D2 and its engine", loads([...diagramFiles, engineFile, workerFile])],
]
console.log(`Wrote ${path.relative(REPO, OUT)} and ${files.size} modules in ${path.relative(REPO, MODULES_DIR)}`)
console.log(`${"".padEnd(36)}       raw       gzip     brotli`)
for (const [label, text] of lines) console.log(`${label.padEnd(36)} ${size(text)}`)
