/**
 * The frame's modules that load the first time a note needs them
 * (frameModuleList.ts), as the app's own lazy parts do
 * (src/lib/moduleLoader.ts). The frame is an opaque-origin `srcdoc` document
 * with no network, so it cannot `import()` a file: it asks the parent, which
 * imports the module's code (a file of the app's build, precached for offline
 * use, src/preview/frame.ts) and posts it back, and the frame runs it here
 * with the frame's own React.
 */
import * as React from "react"
import * as ReactDOM from "react-dom"
import * as jsxRuntime from "react/jsx-runtime"
import * as utils from "../lib/utils"
import { moduleLoader, type ModuleLoader } from "../lib/moduleLoader"
import type { FRAME_SHARED, FrameModuleName } from "./frameModuleList"
import type * as Charts from "./modules/charts"
import type * as Highlighter from "./modules/highlighter"

type FrameModules = { charts: typeof Charts; highlighter: typeof Highlighter }

const SHARED: Record<(typeof FRAME_SHARED)[number], unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  "@/lib/utils": utils,
}

let send: ((name: FrameModuleName) => boolean) | null = null
const waiting = new Map<FrameModuleName, { resolve: (exports: unknown) => void; reject: (error: Error) => void }>()

/** How the frame asks the parent for a module's code; it returns false when it cannot ask yet. */
export function setFrameModuleRequest(request: (name: FrameModuleName) => boolean): void {
  send = request
}

function request(name: FrameModuleName): Promise<unknown> {
  return new Promise((resolve, reject) => {
    waiting.set(name, { resolve, reject })
    if (send?.(name)) return
    waiting.delete(name)
    reject(new Error("The preview is not ready to load this part yet."))
  })
}

/** Run a module's code (built as CommonJS) with the frame's shared modules. */
function evaluate(name: FrameModuleName, code: string): unknown {
  const module = { exports: {} as Record<string, unknown> }
  const require = (id: string) => {
    if (Object.hasOwn(SHARED, id)) return SHARED[id as keyof typeof SHARED]
    throw new Error(`The preview's ${name} part needs ${id}, which the frame does not provide.`)
  }
  new Function("require", "module", "exports", `${code}\n//# sourceURL=frame-${name}.js`)(require, module, module.exports)
  return module.exports
}

/** The parent's answer to a request: the module's code, or why it could not load. */
export function receiveFrameModule(message: { name: FrameModuleName; code?: string; error?: string }): void {
  const pending = waiting.get(message.name)
  if (!pending) return
  waiting.delete(message.name)
  if (message.code === undefined) {
    pending.reject(new Error(message.error ?? "This part of the preview could not load."))
    return
  }
  try {
    pending.resolve(evaluate(message.name, message.code))
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

const loader = <N extends FrameModuleName>(name: N) => moduleLoader(() => request(name) as Promise<FrameModules[N]>)

/** Each module's loader, for `useModule`: it loads once, and a failed load is tried again on the next use. */
export const frameModules: { [N in FrameModuleName]: ModuleLoader<FrameModules[N]> } = {
  charts: loader("charts"),
  highlighter: loader("highlighter"),
}
