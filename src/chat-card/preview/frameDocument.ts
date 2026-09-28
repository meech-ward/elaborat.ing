/**
 * The component preview's frame document: the frame's stylesheet and
 * runtime (runtime.tsx), then one inline script per compiled component file
 * and one for the note. Each wraps the compiler's function body in an async
 * function, as MDX's own `run` does, and hands it to the runtime, which
 * calls them in order once the card says what to show. The browser runs
 * them as the document's own inline scripts: nothing is evaluated from a
 * string, which the MCP Apps default policy would block.
 */
import type { PreviewProgram } from "./compile"

/**
 * Code safe inside a <script> element: `</script` would end it and `<!--`
 * would change how the rest is read. Both are rewritten with escapes that
 * mean the same inside strings, templates and regular expressions.
 */
export function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\u0021--")
}

const script = (code: string) => `<script>${inlineScript(code)}</script>`

export type FrameDocumentOptions = {
  runtime: string
  style: string
  program: PreviewProgram
  /** This run's number, which the frame puts on every message, so a late message from an earlier run is ignored. */
  run: number
  /** The host's scheme, or null for the device's. */
  scheme: "light" | "dark" | null
}

export function frameDocument({ runtime, style, program, run, scheme }: FrameDocumentOptions): string {
  if (/<\/style/i.test(style)) throw new Error("The preview stylesheet cannot be inlined.")
  const root = scheme ? ` data-scheme="${scheme}"${scheme === "dark" ? ' class="dark"' : ""}` : ""
  return (
    `<!doctype html><html lang="en"${root}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${style}</style></head>` +
    `<body><div id="root"></div>` +
    script(runtime) +
    script(`var preview=elaboratingPreview.open(${Number(run)})`) +
    program.modules.map((module, index) => script(`preview.module(${index},async function(){\n${module.code}\n})`)).join("") +
    (program.note === null ? "" : script(`preview.note(async function(){\n${program.note}\n})`)) +
    `</body></html>`
  )
}
