import type { Plugin } from "vite"

const WORKER = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]subset-worker\.chunk\.js$/

// Excalidraw 0.18 subsets fonts in a worker: it imports its
// subset-worker.chunk.js and starts that module's own file as a module worker
// (`new URL(import.meta.url)`), while the page imports subset-shared.chunk.js.
// Both import the same subsetting code (1.8 MB, most of it HarfBuzz and WOFF2
// as wasm), which ships once, as one file for both. The worker's file must
// import nothing that needs the DOM, and on its own rolldown puts the small
// modules the worker shares with Excalidraw's main code in Excalidraw's main
// chunk, which the worker would then load ("document is not defined"). So
// everything the worker's module imports goes in chunks of its own, split by
// what loads each part (`entriesAware`): the subsetting code, and the helpers
// Excalidraw's main code uses too.
export function excalidrawSubsetWorker(): Plugin {
  const workerImports = new Set<string>()
  return {
    name: "excalidraw-subset-worker",
    apply: "build",
    buildEnd() {
      const visit = (id: string) => {
        for (const next of this.getModuleInfo(id)?.importedIds ?? []) {
          if (workerImports.has(next)) continue
          workerImports.add(next)
          visit(next)
        }
      }
      for (const id of this.getModuleIds()) if (WORKER.test(id)) visit(id)
    },
    outputOptions(options) {
      if (options.codeSplitting === false) return
      const splitting = typeof options.codeSplitting === "object" ? options.codeSplitting : {}
      const group = { name: "excalidraw-subset", test: (id: string) => workerImports.has(id), entriesAware: true, priority: 50 }
      return { ...options, codeSplitting: { ...splitting, groups: [...(splitting.groups ?? []), group] } }
    },
  }
}
