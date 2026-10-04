/**
 * The preview frame's document, in the two ways the app serves it:
 *
 * - as the iframe's `srcdoc` (src/preview/frame.ts), with its script inline
 *   and its Content Security Policy in a meta tag;
 * - as a page on the sandbox domain (vite-plugins/preview-frame.ts writes it,
 *   worker/sandbox.ts serves it), with its script as a file beside it and its
 *   policy in a response header.
 *
 * The plugin builds this file on its own (with Tailwind, for the stylesheet)
 * to write the page, so it imports nothing that needs the frame's script.
 */
import { DEFAULT_APPEARANCE, getAppearanceTokens, tokenProperty } from "../features/appearance/tokens";
import previewTailwindCss from "./tailwind.css?inline";
import readingCss from "./reading.css?raw";
import fluidCss from "./fluid.css?raw";
import prosemirrorCss from "prosemirror-view/style/prosemirror.css?raw";

/**
 * The first paint, before the editor sends the chosen appearance: the
 * default palette's tokens (dark), the same variables the appearance
 * message sets. The radii come with the frame's Tailwind theme (radii.css).
 */
const FIRST_PAINT_TOKENS = Object.entries(getAppearanceTokens(DEFAULT_APPEARANCE))
  .map(([key, value]) => `${tokenProperty(key)}:${value}`)
  .join(";");

/** Escape an inline script so it cannot close its own `<script>` element. */
export function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export type FrameHtmlOptions = {
  /** The frame's fonts, as `@font-face` rules with `data:` URLs. */
  fontCss: string;
  /** The frame's script: inline, or a file beside the page (loaded with CORS, so its errors are reported). */
  script: { inline: string } | { src: string };
  /** A policy for a meta tag, for the `srcdoc` document; a served page gets it as a header instead. */
  csp?: string;
};

/** The frame's document. Stable template: same head, viewport and root every time; only the script changes. */
export function frameHtml({ fontCss, script, csp }: FrameHtmlOptions): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "  <head>\n" +
    '    <meta charset="UTF-8" />\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    (csp ? `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n` : "") +
    "    <title>Document preview (isolated)</title>\n" +
    `<style>${fontCss}\n@layer theme, base, components, utilities;@layer base{:root{${FIRST_PAINT_TOKENS}}*{box-sizing:border-box}body{margin:0;padding:30px 40px;background:var(--panel);color:var(--text);font:15.5px/1.6 var(--ui-font)}#root{max-width:760px;margin:auto}h1,h2,h3{font-family:var(--heading-font);line-height:1.25;font-weight:var(--heading-weight)}h1{font-size:32px;line-height:1.15;letter-spacing:var(--heading-tracking)}h2{font-size:21px;font-weight:600}p,li{color:var(--body)}a{color:var(--accent-soft-text)}pre,code,kbd{font-family:var(--code-font)}pre{overflow:auto;padding:16px;background:var(--seg);border-radius:var(--radius-chip)}blockquote{border-left:2px solid var(--accent);padding-left:18px;margin-left:0;color:var(--muted)}button,input,select,textarea{font:inherit;color:var(--text);background:var(--seg);border:1px solid var(--panel-border);border-radius:var(--radius-chip)}button{cursor:pointer;min-height:32px}::selection{background:var(--accent-soft);color:var(--text)}:focus-visible{outline:2px solid var(--focus, var(--accent));outline-offset:2px}@media(max-width:500px){body{padding:4px 22px 24px;font-size:16px}h1{font-size:30px}}[data-resource-pixels]>svg{display:block;max-width:100%;height:auto}[data-resource] figcaption{overflow-wrap:break-word}}\n</style>` +
    // Insert block and its dialog are drawn in reading.css.
    "<style>[data-placeholder]:empty::before{content:attr(data-placeholder);color:var(--muted);pointer-events:none}[data-authoring-block]:empty{min-width:8em}</style>\n" +
    `<style>${previewTailwindCss}</style>\n` +
    `<style>${readingCss}</style>\n` +
    `<style>${prosemirrorCss}\n${fluidCss}</style>\n` +
    "  </head>\n" +
    "  <body>\n" +
    '    <div id="root"></div>\n' +
    ("inline" in script
      ? `    <script>${escapeInlineScript(script.inline)}</script>\n`
      : `    <script src="${script.src}" crossorigin="anonymous"></script>\n`) +
    "  </body>\n" +
    "</html>\n"
  );
}
