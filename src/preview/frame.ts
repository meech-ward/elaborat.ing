/**
 * The preview frame as a `srcdoc` document, for a build without a sandbox
 * domain, and as the fallback when the sandbox domain's frame cannot load
 * (docs/architecture.md, Component isolation).
 *
 * The rendered editor embeds this document as the iframe's `srcdoc`: one
 * inline script and inline styles, no network loads, so the opaque-origin
 * frame (`sandbox="allow-scripts"` only, no `allow-same-origin`) needs no
 * CORS and cannot send data anywhere. The script is
 * `src/preview/preview-entry.tsx`, built by vite-plugins/preview-frame.ts.
 * Charts and code highlighting are built on their own and sent to the frame
 * when a note first needs them (`frameModuleCode`).
 */
import { PREVIEW_CHILD_CSP } from "../features/rendered/protocol";
import { bootstrap as bootstrapJs, fontCss } from "virtual:preview-frame";
import type { FrameModuleName } from "./frameModuleList";
import { frameHtml } from "./frameHtml";

/** Build the self-contained document embedded as the preview iframe's `srcdoc`. */
export function buildPreviewSrcdoc(): string {
  return frameHtml({ fontCss, csp: PREVIEW_CHILD_CSP, script: { inline: bootstrapJs } });
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
