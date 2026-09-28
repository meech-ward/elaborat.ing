import { createRequire } from "node:module"
import path from "node:path"
import type { Plugin } from "vite"

const PREFIX = "d2-engine:"

/**
 * The browser build of @terrastruct/d2 carries its engine (22 MB of wasm) and
 * the ELK layout script as brotli-compressed base64 text in one 8.2 MB module,
 * and unpacks them with a JavaScript decoder on the page's main thread before
 * the first diagram: the page freezes for most of a second, several seconds on
 * a slow phone. In the app build, `@terrastruct/d2` is
 * src/features/structured/d2Engine.ts instead: the same engine, from the
 * package's own files, in a worker that compiles the wasm while it downloads.
 * `d2-engine:<file>` imports one of those files (the package's Node build ships
 * them as they are, byte for byte the ones its browser build embeds), with
 * Vite's `?url` or `?raw`. Tests outside the browser use the package itself.
 */
export function d2Engine(): Plugin {
  const engine = path.dirname(createRequire(import.meta.url).resolve("@terrastruct/d2"))
  const browserEngine = path.resolve(import.meta.dirname, "../src/features/structured/d2Engine.ts")
  return {
    name: "d2-engine",
    enforce: "pre",
    resolveId(source) {
      if (source === "@terrastruct/d2") return browserEngine
      if (!source.startsWith(PREFIX)) return
      const [file, query] = source.slice(PREFIX.length).split("?")
      return path.join(engine, file) + (query ? `?${query}` : "")
    },
  }
}
