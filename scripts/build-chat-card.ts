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
// - live: a new note, drawing or diagram shown while the agent writes it
//   (src/chat-card/lazy/live.ts), drawn with the MCP server's own renderers
// - highlight: the app's code highlighter, after a note with a code block shows
// - compile: the component compiler, for a note with components or a component file
// - frame: the component preview frame's runtime and stylesheet, which the
//   frame itself loads; it loads the charts' library only for a note with a chart
//
// The modules are ES modules with content-hashed names, and the shell loads
// them with import(). The view declares their origin in its CSP
// (fileView.ts). A host that does not allow it blocks them, and the card
// shows the server's HTML, read-only, in the host's or the system's fonts.
//
// Both are committed: the Edge Functions deploy without building the app, and
// the app deploys separately, so the previous build's files stay next to the
// current ones (builds.json), for a view whose function is not deployed yet or
// that a host cached. Run it after changing the card or the app modules it
// uses, and give the view a new ui:// URI:
//
//   bun run build:chat-card               writes both, and prints their sizes
//   bun run build:chat-card --visualize   also writes treemaps to dist-visualize/chat-card/
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { visualizer } from "rollup-plugin-visualizer"
import { build, normalizePath, type Plugin, type PluginOption } from "vite"
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
  frame: path.join(REPO, "src/chat-card/preview/runtime.tsx"),
}
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

/**
 * The MCP server's modules, which the live view shares, import their
 * packages as Deno does (`npm:<package>@<version>[/<file>]`). Each resolves
 * to the app's own copy, which package.json must pin to the same version, so
 * the card and the server cannot draw differently.
 */
const pinned: Record<string, string> = (() => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"))
  return { ...manifest.dependencies, ...manifest.devDependencies }
})()
const npmSpecifiers: Plugin = {
  name: "npm-specifiers",
  enforce: "pre",
  resolveId(source, importer, options) {
    const match = /^npm:((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.*)?$/.exec(source)
    if (!match) return null
    const [, name, version, file = ""] = match
    if (pinned[name] !== version) throw new Error(`${source} needs ${name} ${version} in package.json, which has ${pinned[name] ?? "none"}.`)
    return this.resolve(name + file, importer, { ...options, skipSelf: true })
  },
}

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
  return id === `${SRC}chat-card/main.tsx` || id === `${SRC}chat-card/jitless.ts`
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
    resolve: { alias: { "@": path.join(REPO, "src") } },
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

// The modules first: the shell carries their addresses. None of them makes
// requests or evaluates strings; the frame's modules run under the view's
// policy too, which has no 'unsafe-eval'.
const modules = await run(MODULE_ENTRIES, "modules", "es", {})
const chunks = modules.filter((item): item is OutputChunk => item.type === "chunk")
for (const chunk of chunks) {
  if (/\beval\(|new Function\b|\bfetch\(|XMLHttpRequest/.test(chunk.code)) throw new Error(`The chat card module ${chunk.fileName} evaluates strings or makes requests.`)
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

// The files, next to the committed build's: builds.json lists both. The
// committed one is what the last deploy serves, so builds between commits
// replace each other, not it. A build the same as the committed one changes
// nothing. Without git (a copy of the repository), the files on disk count.
type Builds = { current: string[]; previous: string[] }
mkdirSync(MODULES_DIR, { recursive: true })
const committed = (): Builds | null => {
  try {
    return JSON.parse(execFileSync("git", ["show", "HEAD:public/chat-card/builds.json"], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString())
  } catch {
    return null
  }
}
const fromGit = committed()
const before: Builds = fromGit ?? (existsSync(BUILDS) ? JSON.parse(readFileSync(BUILDS, "utf8")) : { current: [], previous: [] })
const written = [...files.keys()].sort()
const builds: Builds = written.join() === [...before.current].sort().join() ? before : { current: written, previous: before.current }
// A committed file an earlier build removed comes back from git.
for (const name of builds.previous) {
  if (fromGit && !files.has(name) && !existsSync(path.join(MODULES_DIR, name))) {
    writeFileSync(path.join(MODULES_DIR, name), execFileSync("git", ["show", `HEAD:public/chat-card/${name}`], { cwd: REPO }))
  }
}
const kept = new Set([...builds.current, ...builds.previous, "builds.json"])
for (const name of readdirSync(MODULES_DIR)) if (!kept.has(name)) rmSync(path.join(MODULES_DIR, name))
for (const [name, text] of files) writeFileSync(path.join(MODULES_DIR, name), text)
writeFileSync(BUILDS, `${JSON.stringify(builds, null, 2)}\n`)

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
const charts = [...frameFiles].flatMap((file) => chunks.find((chunk) => chunk.fileName === file)?.dynamicImports ?? [])
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
]
console.log(`Wrote ${path.relative(REPO, OUT)} and ${written.length} modules in ${path.relative(REPO, MODULES_DIR)}`)
console.log(`${"".padEnd(36)}       raw       gzip     brotli`)
for (const [label, text] of lines) console.log(`${label.padEnd(36)} ${size(text)}`)
