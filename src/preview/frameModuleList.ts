// No imports: vite-plugins/preview-frame.ts reads this file too.

/**
 * Parts of the note preview frame that load the first time a note needs
 * them, each built on its own from `src/preview/modules/<name>.ts`
 * (vite-plugins/preview-frame.ts): `charts` (Recharts and the chart
 * components) and `highlighter` (the code highlighter and its grammars).
 */
export const FRAME_MODULES = ["charts", "highlighter"] as const
export type FrameModuleName = (typeof FRAME_MODULES)[number]

/**
 * What a frame module takes from the frame's own script instead of bundling
 * a copy: one React for the whole frame (hooks need that), and the frame's
 * class-name helper. The build stops when a module needs anything else from
 * outside (src/preview/frameModules.ts provides these).
 */
export const FRAME_SHARED = ["react", "react/jsx-runtime", "react-dom", "@/lib/utils"] as const
