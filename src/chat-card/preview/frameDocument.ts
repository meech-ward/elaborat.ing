/**
 * The component preview's frame document: the frame's stylesheet, one inline
 * script per compiled component file and one for the note, and the frame's
 * runtime (runtime.tsx), which the frame imports from elaborat.ing (the
 * card's modules, ../modules.ts). Each compiled file's script wraps the
 * compiler's function body in an async function, as MDX's own `run` does,
 * and puts it in the document's registry; the runtime calls them in order
 * once the card says what to show. The browser runs them as the document's
 * own inline scripts: nothing is evaluated from a string, which the view's
 * policy would block. If the runtime does not load, the frame tells the card,
 * which keeps what it showed.
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

/** What the card says when the frame's runtime did not load. */
export const FRAME_NOT_LOADED = "the preview could not load from elaborat.ing."

export type FrameDocumentOptions = {
  /** The runtime's and the stylesheet's addresses. */
  runtime: string
  style: string
  program: PreviewProgram
  /** This run's number, which the frame puts on every message, so a late message from an earlier run is ignored. */
  run: number
  /** The host's scheme, or null for the device's. */
  scheme: "light" | "dark" | null
}

export function frameDocument({ runtime, style, program, run, scheme }: FrameDocumentOptions): string {
  const root = scheme ? ` data-scheme="${scheme}"${scheme === "dark" ? ' class="dark"' : ""}` : ""
  const failed = JSON.stringify({ type: "failed", run: Number(run), message: FRAME_NOT_LOADED })
  const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  return (
    `<!doctype html><html lang="en"${root}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // Before the stylesheet, so the runtime loads alongside it. The runtime waits for the whole document.
    script(
      `var preview={run:${Number(run)},modules:[],note:null};` +
        `import(${JSON.stringify(runtime)}).then(function(runtime){runtime.open(preview)},function(){parent.postMessage(${failed},"*")})`,
    ) +
    `<link rel="stylesheet" href="${attribute(style)}"></head>` +
    `<body><div id="root"></div>` +
    program.modules.map((module, index) => script(`preview.modules[${index}]=async function(){\n${module.code}\n}`)).join("") +
    (program.note === null ? "" : script(`preview.note=async function(){\n${program.note}\n}`)) +
    `</body></html>`
  )
}
