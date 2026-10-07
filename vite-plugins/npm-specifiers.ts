import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

/**
 * The MCP server's modules that the chat card and the app share (the live
 * view's renderers in supabase/functions/mcp-server/tools) import their
 * packages as Deno does (`npm:<package>@<version>[/<file>]`). Each resolves
 * to the app's own copy, which package.json must pin to the same version, so
 * the server, the card and the app cannot draw differently.
 */
export function npmSpecifiers(root: string): Plugin {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const pinned: Record<string, string> = { ...manifest.dependencies, ...manifest.devDependencies }
  return {
    name: "npm-specifiers",
    enforce: "pre",
    resolveId(source, importer, options) {
      const match = /^npm:((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.*)?$/.exec(source)
      if (!match) return null
      const [, name, version, file = ""] = match
      if (pinned[name] !== version) throw new Error(`${source} needs ${name} ${version} in package.json, which has ${pinned[name] ?? "none"}.`)
      return this.resolve(name + file, importer, { ...options, skipSelf: true })
    },
  }
}
