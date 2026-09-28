/**
 * Self-contained document for the isolated preview frame.
 *
 * The rendered editor embeds this document as the iframe's `srcdoc`: one
 * inline script and inline styles, no network loads, so the opaque-origin
 * frame (`sandbox="allow-scripts"` only, no `allow-same-origin`) needs no
 * CORS and cannot send data anywhere. The script is
 * `src/preview/preview-entry.tsx`, built by vite-plugins/preview-frame.ts.
 * Charts and code highlighting are built on their own and sent to the frame
 * when a note first needs them (`frameModuleCode`).
 */
import { DEFAULT_APPEARANCE, getAppearanceTokens, tokenProperty } from "../features/appearance/tokens";
import { PREVIEW_CHILD_CSP } from "../features/rendered/protocol";
import { bootstrap as bootstrapJs, fontCss } from "virtual:preview-frame";
import type { FrameModuleName } from "./frameModuleList";
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

/**
 * Build the self-contained document embedded as the preview iframe's
 * `srcdoc`. Stable template: same head, viewport, CSP and root on every
 * call; only the bundled bootstrap changes when rebuilt.
 */
export function buildPreviewSrcdoc(): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "  <head>\n" +
    '    <meta charset="UTF-8" />\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    `    <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CHILD_CSP}" />\n` +
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
    `    <script>${escapeInlineScript(bootstrapJs)}</script>\n` +
    "  </body>\n" +
    "</html>\n"
  );
}

/** Each frame module's code, as a file of its own that loads the first time a frame asks for it. */
const FRAME_MODULE_CODE: Record<FrameModuleName, () => Promise<{ code: string }>> = {
  charts: () => import("virtual:preview-frame/charts"),
  highlighter: () => import("virtual:preview-frame/highlighter"),
};

/** The code of a frame module (src/preview/frameModules.ts), for the frame to run. */
export async function frameModuleCode(name: FrameModuleName): Promise<string> {
  return (await FRAME_MODULE_CODE[name]()).code;
}
