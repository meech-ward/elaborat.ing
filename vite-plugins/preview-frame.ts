import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { build, type Plugin } from "vite"
import { FRAME_MODULES, FRAME_SHARED, type FrameModuleName } from "../src/preview/frameModuleList.ts"
import type { frameHtml } from "../src/preview/frameHtml.ts"
import { pageFolder, writeFrameVersions } from "./frame-versions.ts"

// The rendered view evaluates document code only inside an opaque-origin
// iframe (sandbox="allow-scripts", no network), so the frame's script and
// fonts are inlined into its srcdoc. This plugin builds the frame's entry,
// src/preview/preview-entry.tsx, with Vite as one IIFE and serves it as the
// module "virtual:preview-frame". Building through Vite also means the
// frame's npm packages get license notices: they are merged into the app's
// build.license file.
//
// The frame's heavier parts, charts and code highlighting, load the first
// time a note needs them (src/preview/frameModuleList.ts): each
// src/preview/modules/<name>.ts is built on its own as CommonJS that takes
// React from the frame, and served as "virtual:preview-frame/<name>", which
// the app imports when the frame asks for it (src/preview/frame.ts).
//
// The same files make the frame's page on a sandbox domain (docs/architecture.md,
// Component isolation): with `sandboxDir`, the build writes
// <sandboxDir>/frame/<hash>/ with index.html (src/preview/frameHtml.ts, the
// script as a file), frame.js, and each module as <name>.js, which registers
// its code with the frame (`elaboratingFrameModule`, src/preview/frameModules.ts).
// The hash names this build's frame files, so a page and its modules never
// mix versions. The app finds the folder in "virtual:preview-frame/page".

const VIRTUAL = "virtual:preview-frame"
const RESOLVED = `\0${VIRTUAL}`
/** The repository root: the frame's entry and fonts are found from here, whatever config uses the plugin. */
const REPO = path.resolve(import.meta.dirname, "..")
const ENTRY = path.join(REPO, "src/preview/preview-entry.tsx")
const HTML = path.join(REPO, "src/preview/frameHtml.ts")
const PAGE = `${VIRTUAL}/page`
const UTILS = path.join(REPO, "src/lib/utils.ts")

/** Fonts the frame embeds as data URLs, since the frame cannot load URLs. */
const FONTS: Array<[family: string, file: string, weight: string]> = [
  ["Space Grotesk Variable", "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2", "300 700"],
  ["JetBrains Mono Variable", "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", "100 800"],
]

type FrameBuild = { code: string; licenses: string; modules: Set<string> }

type Output = {
  output: Array<
    | { type: "chunk"; code: string; moduleIds: string[] }
    | { type: "asset"; fileName: string; source: string | Uint8Array }
  >
}

/**
 * A frame module takes these from the frame (src/preview/frameModules.ts)
 * instead of bundling its own copy: React, and the class-name helper.
 */
function sharedWithFrame(): Plugin {
  return {
    name: "preview-frame-shared",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if ((FRAME_SHARED as readonly string[]).includes(source)) return { id: source, external: true }
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved?.id === UTILS) return { id: "@/lib/utils", external: true }
      return resolved
    },
  }
}

/** The frame's script (`module` undefined), or one of its modules. */
async function buildFrame(module?: FrameModuleName): Promise<FrameBuild> {
  const result = (await build({
    configFile: false,
    root: REPO,
    mode: "production",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: { "@": path.join(REPO, "src") } },
    plugins: [react(), ...(module ? [sharedWithFrame()] : [])],
    build: {
      write: false,
      minify: true,
      license: { fileName: "frame-licenses.md" },
      lib: module
        ? { entry: path.join(REPO, `src/preview/modules/${module}.ts`), formats: ["cjs"], fileName: () => `${module}.js` }
        : { entry: ENTRY, formats: ["iife"], name: "elaboratingFrame", fileName: () => "frame.js" },
    },
  })) as Output | Output[]
  const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
  const chunks = output.filter((item) => item.type === "chunk")
  const chunk = chunks[0]
  const licenses = output.find((item) => item.type === "asset" && item.fileName === "frame-licenses.md")
  if (!chunk || chunk.type !== "chunk" || chunks.length > 1) throw new Error(`The preview frame build${module ? ` of ${module}` : ""} did not produce one script.`)
  if (module) {
    const missing = [...chunk.code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]).filter((id) => !(FRAME_SHARED as readonly string[]).includes(id))
    if (missing.length) throw new Error(`The preview frame's ${module} module needs ${[...new Set(missing)].join(", ")}, which the frame does not provide (src/preview/frameModuleList.ts).`)
  }
  const licenseText = licenses?.type === "asset" ? (typeof licenses.source === "string" ? licenses.source : new TextDecoder().decode(licenses.source)) : ""
  return { code: chunk.code, licenses: licenseText, modules: new Set(chunk.moduleIds) }
}

function fontCss(): string {
  const require = createRequire(path.join(REPO, "package.json"))
  return FONTS.map(([family, file, weight]) => {
    const bytes = readFileSync(require.resolve(file)).toString("base64")
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${bytes}) format('woff2')}`
  }).join("")
}

/**
 * The frame's page, with its script as a file beside it: src/preview/frameHtml.ts
 * built on its own (with Tailwind, for the frame's stylesheet) and run here.
 */
async function buildPage(fonts: string): Promise<string> {
  const result = (await build({
    configFile: false,
    root: REPO,
    mode: "production",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: { "@": path.join(REPO, "src") } },
    plugins: [tailwindcss()],
    build: { write: false, minify: true, lib: { entry: HTML, formats: ["cjs"], fileName: () => "page.js" } },
  })) as Output | Output[]
  const chunks = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output).filter((item) => item.type === "chunk")
  if (chunks.length !== 1 || chunks[0].type !== "chunk") throw new Error("The preview frame's page did not build as one script.")
  const module = { exports: {} as { frameHtml?: typeof frameHtml } }
  const require = (id: string) => {
    throw new Error(`The preview frame's page needs ${id}, which it should bundle.`)
  }
  new Function("module", "exports", "require", chunks[0].code)(module, module.exports, require)
  if (!module.exports.frameHtml) throw new Error("The preview frame's page did not export frameHtml.")
  return module.exports.frameHtml({ fontCss: fonts, script: { src: "frame.js" } })
}

/** The frame's files for a sandbox domain, by name, and the folder they go in (named after their contents). */
type Page = { folder: string; files: Record<string, string> }

/** A module's file: its CommonJS code, registered with the frame that loads it. */
function moduleFile(name: FrameModuleName, code: string): string {
  return `elaboratingFrameModule(${JSON.stringify(name)},function(require,module,exports){\n${code}\n});\n`
}

/**
 * Add the frame's package sections ("## name - version (license)") that the
 * app's notices do not already have.
 */
export function mergeLicenses(app: string, frame: string): string {
  let merged = app
  for (const section of frame.split(/^(?=## )/m).filter((part) => part.startsWith("## "))) {
    const heading = section.slice(0, section.indexOf("\n") === -1 ? undefined : section.indexOf("\n"))
    if (merged.includes(`\n${heading}\n`) || merged.startsWith(`${heading}\n`)) continue
    merged = `${merged.replace(/\n*$/, "\n\n")}${section.replace(/\n*$/, "\n")}`
  }
  return merged
}

export function previewFrame(options: { sandboxDir?: string } = {}): Plugin {
  // The builds this app build includes, by virtual module id: the frame's
  // script and its modules. Only those are listed in the licenses.
  const builds = new Map<string, Promise<FrameBuild>>()
  const moduleOf = (id: string): FrameModuleName | undefined => FRAME_MODULES.find((name) => id === `${RESOLVED}/${name}`)
  const current = (id: string) => {
    let frame = builds.get(id)
    if (!frame) builds.set(id, (frame = buildFrame(moduleOf(id))))
    return frame
  }
  let page: Promise<Page> | null = null
  const sandboxPage = () =>
    (page ??= (async () => {
      const files: Record<string, string> = { "index.html": await buildPage(fontCss()), "frame.js": (await current(RESOLVED)).code }
      for (const name of FRAME_MODULES) files[`${name}.js`] = moduleFile(name, (await current(`${RESOLVED}/${name}`)).code)
      return { folder: pageFolder(files), files }
    })())
  let building = false
  return {
    name: "preview-frame",
    configResolved(config) {
      building = config.command === "build"
    },
    resolveId(id) {
      if (id === VIRTUAL || id === PAGE || FRAME_MODULES.some((name) => id === `${VIRTUAL}/${name}`)) return `\0${id}`
    },
    async load(id) {
      if (id === RESOLVED) {
        const { code } = await current(id)
        return `export const bootstrap = ${JSON.stringify(code)}\nexport const fontCss = ${JSON.stringify(fontCss())}\n`
      }
      if (id === `\0${PAGE}`) return `export const FRAME_PAGE_PATH = ${JSON.stringify((await sandboxPage()).folder)}\n`
      if (moduleOf(id)) return `export const code = ${JSON.stringify((await current(id)).code)}\n`
    },
    // In dev, rebuild the frame and its modules when a file they bundle changes.
    async hotUpdate({ file }) {
      if (this.environment.name !== "client" || builds.size === 0) return
      const bundled = await Promise.all([...builds.values()].map(async (frame) => (await frame).modules.has(file)))
      if (!bundled.includes(true)) return
      for (const id of [...builds.keys(), `\0${PAGE}`]) {
        const module = this.environment.moduleGraph.getModuleById(id)
        if (module) this.environment.moduleGraph.invalidateModule(module)
      }
      builds.clear()
      page = null
      this.environment.hot.send({ type: "full-reload" })
    },
    // The frame's page for a sandbox domain, in a folder of its own: this
    // build's version, listed in frame/versions.json. A deploy adds the last
    // few versions before it (vite-plugins/frame-versions.ts).
    async writeBundle() {
      if (!options.sandboxDir || !building || this.environment.name !== "client") return
      const { folder, files } = await sandboxPage()
      rmSync(options.sandboxDir, { recursive: true, force: true })
      const dir = path.join(options.sandboxDir, folder)
      mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
      writeFrameVersions(options.sandboxDir, [{ folder, files: Object.keys(files) }])
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const license = this.environment.config.build.license
        if (!license || builds.size === 0) return
        const notices = bundle[license === true ? ".vite/license.md" : license.fileName]
        if (notices?.type !== "asset") return
        let text = typeof notices.source === "string" ? notices.source : new TextDecoder().decode(notices.source)
        for (const frame of builds.values()) text = mergeLicenses(text, (await frame).licenses)
        notices.source = text
      },
    },
  }
}
