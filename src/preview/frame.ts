/**
 * Self-contained document for the isolated preview frame.
 *
 * The rendered editor embeds this document as the iframe's `srcdoc`: one
 * inline script and inline styles, no network loads, so the opaque-origin
 * frame (`sandbox="allow-scripts"` only, no `allow-same-origin`) needs no
 * CORS and cannot send data anywhere. The script is
 * `src/preview/preview-entry.tsx`, built by vite-plugins/preview-frame.ts.
 */
import { PREVIEW_CHILD_CSP } from "../features/rendered/protocol";
import { bootstrap as bootstrapJs, fontCss } from "virtual:preview-frame";
import previewTailwindCss from "./tailwind.css?inline";
import readingCss from "./reading.css?raw";
import fluidCss from "./fluid.css?raw";
import prosemirrorCss from "prosemirror-view/style/prosemirror.css?raw";

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
    `<style>${fontCss}\n@layer theme, base, components, utilities;@layer base{:root{--bg:#191c22;--text:#e8edf5;--muted:#a5afc0;--line:#353c49;--accent:#91b7ff;--raised:#262b34;--ui-font:'Inter Variable',sans-serif;--heading-font:var(--ui-font);--code-font:'IBM Plex Mono',monospace;--heading-weight:550;--heading-tracking:-1.7px}*{box-sizing:border-box}body{margin:0;padding:48px 36px;background:var(--bg);color:var(--text);font:14px/1.85 var(--ui-font)}#root{max-width:760px;margin:auto}h1,h2,h3{font-family:var(--heading-font);line-height:1.25;font-weight:var(--heading-weight)}h1{font-size:38px;letter-spacing:var(--heading-tracking)}h2{font-size:23px}p,li{color:var(--text)}a{color:var(--accent)}pre,code,kbd{font-family:var(--code-font)}pre{overflow:auto;padding:16px;background:var(--raised);border-radius:5px}blockquote{border-left:2px solid var(--accent);padding-left:18px;margin-left:0;color:var(--muted)}button,input,select,textarea{font:inherit;color:var(--text);background:var(--raised);border:1px solid var(--line);border-radius:4px}button{cursor:pointer;min-height:32px}::selection{background:var(--selection);color:var(--text)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:500px){body{padding:28px 20px;font-size:13px}h1{font-size:29px}h2{font-size:20px}}[data-resource-pixels]>svg{display:block;max-width:100%;height:auto}[data-resource] figcaption{overflow-wrap:break-word}}\n</style>` +
    "<style>[data-placeholder]:empty::before{content:attr(data-placeholder);color:var(--muted);pointer-events:none}[data-authoring-block]:empty{min-width:8em}.authoring-insert{margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}.authoring-insert button{min-height:40px;padding:5px 12px}.authoring-insert dialog{color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;width:min(440px,calc(100vw - 32px));max-height:85dvh;overflow:auto;padding:24px}.authoring-insert dialog::backdrop{background:#0008}.authoring-insert label{display:grid;gap:4px;margin:12px 0}.authoring-insert select{min-height:40px;width:100%;min-width:0}.authoring-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}</style>\n" +
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
