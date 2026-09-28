// Builds the chat card (src/chat-card/main.tsx: the MCP Apps view of
// show_file, a small React app with the rendered note editor) into one script
// and one stylesheet, and writes them where the MCP server inlines them into
// the view. The component preview's frame (src/chat-card/preview/runtime.tsx)
// is built first, into a script and stylesheet the card carries as text and
// puts in each preview's frame document. The Edge Functions deploy from the repository without building
// the app, so the built card is committed. Run it after changing the card or
// the app modules it uses:
//
//   bun run build:chat-card
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { build } from "vite"
import { COLOR_TOKEN_KEYS } from "../src/features/appearance/paletteCss"
import { DEFAULT_THEME, getAppearanceTokens, tokenProperty, type ColorScheme } from "../src/features/appearance/tokens"
import { beforeDarkFilter } from "../src/features/drawings/presentation"

const REPO = path.resolve(import.meta.dirname, "..")
const ENTRY = path.join(REPO, "src/chat-card/main.tsx")
const PREVIEW_ENTRY = path.join(REPO, "src/chat-card/preview/runtime.tsx")
const OUT = path.join(REPO, "supabase/functions/mcp-server/tools/cardEditorScript.ts")

// Excalifont's Latin subset (U+20-7E and the Latin-1 letters), the font the
// server names first for text in drawings. The name is the pinned
// Excalidraw's; the build stops here if an upgrade renames it.
const EXCALIFONT = "fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"
const excalidraw = path.dirname(createRequire(path.join(REPO, "package.json")).resolve("@excalidraw/excalidraw"))
const excalifont = `data:font/woff2;base64,${readFileSync(path.join(excalidraw, EXCALIFONT)).toString("base64")}`

type Output = {
  output: Array<{ type: "chunk"; code: string } | { type: "asset"; fileName: string; source: string | Uint8Array }>
}

/** One entry built as an IIFE with the app's aliases, React and Tailwind: its script and stylesheet. */
async function bundle(entry: string, name: string, define: Record<string, string>) {
  const result = (await build({
    configFile: false,
    root: REPO,
    mode: "production",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), ...define },
    resolve: { alias: { "@": path.join(REPO, "src") } },
    plugins: [react(), tailwindcss()],
    build: {
      write: false,
      minify: true,
      cssMinify: true,
      lib: { entry, formats: ["iife"], name, fileName: () => `${name}.js`, cssFileName: name },
    },
  })) as Output | Output[]
  const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
  const chunk = output.find((item) => item.type === "chunk")
  const sheet = output.find((item) => item.type === "asset" && item.fileName.endsWith(".css"))
  if (!chunk || chunk.type !== "chunk") throw new Error(`The ${name} build produced no script.`)
  if (!sheet || sheet.type !== "asset") throw new Error(`The ${name} build produced no stylesheet.`)
  return { code: chunk.code, css: (typeof sheet.source === "string" ? sheet.source : new TextDecoder().decode(sheet.source)).trim() }
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

// The preview's frame first: the card carries its script and stylesheet as
// text. Its code runs only in the frame, and makes no requests and evaluates
// no strings, like the card's.
const frame = await bundle(PREVIEW_ENTRY, "elaboratingPreview", {})
const frameCss = palette + frame.css
if (/\beval\(|new Function\b|\bfetch\(|XMLHttpRequest/.test(frame.code)) throw new Error("The preview frame's script evaluates strings or makes requests.")
const card = await bundle(ENTRY, "elaboratingChatCard", {
  EXCALIFONT_LATIN: JSON.stringify(excalifont),
  PREVIEW_RUNTIME: JSON.stringify(frame.code),
  PREVIEW_STYLE: JSON.stringify(frameCss),
})
const css = palette + card.css
if (/<\/style/i.test(css) || /<\/style/i.test(frameCss)) throw new Error("The chat card stylesheet cannot be inlined.")

// The script goes inside a <script> element, where these would end it early.
const code = card.code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")
if (/<\/script|<!--/i.test(code)) throw new Error("The chat card script cannot be inlined.")

writeFileSync(
  OUT,
  "// Generated by `bun run build:chat-card` from src/chat-card. Do not edit.\n" +
    "// Third-party licenses: https://elaborat.ing/third-party-notices.txt\n" +
    `export const CARD_STYLE = ${JSON.stringify(css)}\n` +
    `export const CARD_SCRIPT = ${JSON.stringify(code)}\n`,
)
console.log(
  `Wrote ${path.relative(REPO, OUT)}: ${code.length} characters of script (${frame.code.length + frameCss.length} of them the preview frame's), ${css.length} of style`,
)
