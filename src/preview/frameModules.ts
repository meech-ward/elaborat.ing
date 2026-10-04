/**
 * The frame's modules that load the first time a note needs them
 * (frameModuleList.ts), as the app's own lazy parts do
 * (src/lib/moduleLoader.ts), and run here with the frame's own React.
 *
 * On the sandbox domain the frame loads each module's file from beside its
 * page (`loadModuleFiles`). As a `srcdoc` document it has no files of its
 * own, so it asks the parent, which imports the module's code (a file of the
 * app's build, precached for offline use, src/preview/frame.ts) and posts it
 * back.
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

/** A module's CommonJS code as a function: how a module's file registers it (vite-plugins/preview-frame.ts). */
type ModuleFactory = (require: (id: string) => unknown, module: { exports: Record<string, unknown> }, exports: Record<string, unknown>) => void

/** Run a module's code (built as CommonJS) with the frame's shared modules. */
function evaluate(name: FrameModuleName, code: string | ModuleFactory): unknown {
  const module = { exports: {} as Record<string, unknown> }
  const require = (id: string) => {
    if (Object.hasOwn(SHARED, id)) return SHARED[id as keyof typeof SHARED]
    throw new Error(`The preview's ${name} part needs ${id}, which the frame does not provide.`)
  }
  const factory = typeof code === "string" ? (new Function("require", "module", "exports", `${code}\n//# sourceURL=frame-${name}.js`) as ModuleFactory) : code
  factory(require, module, module.exports)
  return module.exports
}

/** A request's answer: the module's code, or why it could not load. */
function settle(name: FrameModuleName, code: string | ModuleFactory | undefined, reason?: string): void {
  const pending = waiting.get(name)
  if (!pending) return
  waiting.delete(name)
  if (code === undefined) {
    pending.reject(new Error(reason ?? "This part of the preview could not load."))
    return
  }
  try {
    pending.resolve(evaluate(name, code))
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/** The parent's answer to a request: the module's code, or why it could not load. */
export function receiveFrameModule(message: { name: FrameModuleName; code?: string; error?: string }): void {
  settle(message.name, message.code, message.error)
}

/**
 * On the sandbox domain: load each module from its file beside the frame's
 * page (`<name>.js`), which registers its code with `elaboratingFrameModule`.
 * The page's policy allows scripts from its own folder only.
 */
export function loadModuleFiles(): void {
  const registered = new Map<FrameModuleName, ModuleFactory>()
  Object.assign(window, {
    elaboratingFrameModule: (name: FrameModuleName, factory: ModuleFactory) => {
      registered.set(name, factory)
    },
  })
  send = (name) => {
    const script = document.createElement("script")
    script.src = `${name}.js`
    // With CORS, so an error in the module's code is reported with its message.
    script.crossOrigin = "anonymous"
    const done = () => {
      script.remove()
      const factory = registered.get(name)
      registered.delete(name)
      settle(name, factory)
    }
    script.addEventListener("load", done)
    script.addEventListener("error", done)
    document.head.append(script)
    return true
  }
}

const loader = <N extends FrameModuleName>(name: N) => moduleLoader(() => request(name) as Promise<FrameModules[N]>)

/** Each module's loader, for `useModule`: it loads once, and a failed load is tried again on the next use. */
export const frameModules: { [N in FrameModuleName]: ModuleLoader<FrameModules[N]> } = {
  charts: loader("charts"),
  highlighter: loader("highlighter"),
}
