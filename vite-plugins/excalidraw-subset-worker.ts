import path from "node:path"
import type { Plugin } from "vite"

// Excalidraw 0.18 discovers its font worker with a normal dynamic import.
// Treating that import as app code lets shared chunks pull the DOM entry into
// the worker. Keep its WorkerUrl API, but give Vite a separate worker graph.
export function excalidrawSubsetWorker(): Plugin {
  const prefix = "\0excalidraw-subset-worker:"
  return {
    name: "excalidraw-subset-worker",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "./subset-worker.chunk.js" || !importer?.includes("/@excalidraw/excalidraw/dist/")) return
      return prefix + path.resolve(path.dirname(importer), source)
    },
    load(id) {
      if (!id.startsWith(prefix)) return
      return `import workerUrl from ${JSON.stringify(id.slice(prefix.length) + "?worker&url")}; export const WorkerUrl = new URL(workerUrl, import.meta.url);`
    },
  }
}
