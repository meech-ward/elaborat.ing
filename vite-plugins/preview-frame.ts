import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import react from "@vitejs/plugin-react"
import { build, type Plugin } from "vite"

// The rendered view evaluates document code only inside an opaque-origin
// iframe (sandbox="allow-scripts", no network), so the frame's script and
// fonts are inlined into its srcdoc. This plugin builds the frame's entry,
// src/preview/preview-entry.tsx, with Vite as one IIFE and serves it as the
// module "virtual:preview-frame". Building through Vite also means the
// frame's npm packages get license notices: they are merged into the app's
// build.license file.

const VIRTUAL = "virtual:preview-frame"
const RESOLVED = `\0${VIRTUAL}`
/** The repository root: the frame's entry and fonts are found from here, whatever config uses the plugin. */
const REPO = path.resolve(import.meta.dirname, "..")
const ENTRY = path.join(REPO, "src/preview/preview-entry.tsx")

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

async function buildFrame(): Promise<FrameBuild> {
  const result = (await build({
    configFile: false,
    root: REPO,
    mode: "production",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: { "@": path.join(REPO, "src") } },
    plugins: [react()],
    build: {
      write: false,
      minify: true,
      license: { fileName: "frame-licenses.md" },
      lib: { entry: ENTRY, formats: ["iife"], name: "elaboratingFrame", fileName: () => "frame.js" },
    },
  })) as Output | Output[]
  const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
  const chunk = output.find((item) => item.type === "chunk")
  const licenses = output.find((item) => item.type === "asset" && item.fileName === "frame-licenses.md")
  if (!chunk || chunk.type !== "chunk") throw new Error("The preview frame build produced no script.")
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

export function previewFrame(): Plugin {
  let frame: Promise<FrameBuild> | null = null
  // Whether this build includes the frame; only then are its licenses listed.
  let used = false
  const current = () => (frame ??= buildFrame())
  return {
    name: "preview-frame",
    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED
    },
    async load(id) {
      if (id !== RESOLVED) return
      used = true
      const { code } = await current()
      return `export const bootstrap = ${JSON.stringify(code)}\nexport const fontCss = ${JSON.stringify(fontCss())}\n`
    },
    // In dev, rebuild the frame when a file it bundles changes.
    async hotUpdate({ file }) {
      if (this.environment.name !== "client" || !frame || !(await frame).modules.has(file)) return
      frame = null
      const module = this.environment.moduleGraph.getModuleById(RESOLVED)
      if (module) this.environment.moduleGraph.invalidateModule(module)
      this.environment.hot.send({ type: "full-reload" })
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const license = this.environment.config.build.license
        if (!license || !used) return
        const notices = bundle[license === true ? ".vite/license.md" : license.fileName]
        if (notices?.type !== "asset") return
        const text = typeof notices.source === "string" ? notices.source : new TextDecoder().decode(notices.source)
        notices.source = mergeLicenses(text, (await current()).licenses)
      },
    },
  }
}
