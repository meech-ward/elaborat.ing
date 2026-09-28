// Built by vite-plugins/preview-frame.ts.
declare module "virtual:preview-frame" {
  /** The frame's script: src/preview/preview-entry.tsx as one IIFE. */
  export const bootstrap: string
  /** @font-face rules with the frame's fonts as data URLs. */
  export const fontCss: string
}

declare module "virtual:preview-frame/*" {
  /** A frame module (src/preview/modules/<name>.ts) as CommonJS, for src/preview/frameModules.ts to run. */
  export const code: string
}
