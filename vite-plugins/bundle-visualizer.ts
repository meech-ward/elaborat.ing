import type { Plugin } from "vite"
import { visualizer } from "rollup-plugin-visualizer"

// `bun run build:visualize` (`vite build --mode visualize`) is the production
// build written to dist-visualize/app with a manifest, plus every chunk's
// modules with their gzip and brotli sizes: a treemap to open in a browser
// (dist-visualize/stats.html) and the same data as JSON
// (dist-visualize/stats.json). `bun run report:bundle` reads the manifest and
// the JSON. Other modes and dev get none of this.
export function bundleVisualizer(): Plugin[] {
  const onlyThere = (plugin: Plugin): Plugin => ({ ...plugin, apply: (_config, env) => env.command === "build" && env.mode === "visualize" })
  const sizes = { gzipSize: true, brotliSize: true } as const
  return [
    onlyThere({ name: "bundle-visualizer-output", config: () => ({ build: { outDir: "dist-visualize/app", manifest: true } }) }),
    onlyThere(visualizer({ ...sizes, filename: "dist-visualize/stats.html", template: "treemap", title: "elaborat.ing bundle" }) as Plugin),
    onlyThere(visualizer({ ...sizes, filename: "dist-visualize/stats.json", template: "raw-data" }) as Plugin),
  ]
}
