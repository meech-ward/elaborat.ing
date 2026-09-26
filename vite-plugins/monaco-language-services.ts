import type { Plugin } from "vite"

// Monaco's entry (monaco-editor/esm/vs/index.js) registers the TypeScript,
// CSS and HTML language services, and each one's worker is built even when
// nothing starts it: about 8 MB the app never uses, since its editors use
// Markdown, MDX, JSON, plain text and D2. This leaves the named services out
// of the build, as the `features` option of Monaco's webpack plugin does. The
// entry still exports their names, as empty objects. Highlighting of code in
// notes comes from the language definitions, which stay.

const ENTRY = /\/monaco-editor\/esm\/vs\/index\.js$/

/** Monaco's entry without the named language services. Throws if one is not imported where expected. */
export function withoutLanguageServices(code: string, names: readonly string[]): string {
  let result = code
  for (const name of names) {
    const line = new RegExp(`^import \\* as (\\w+) from '\\./languages/features/${name}/register\\.js';$`, "m")
    const match = line.exec(result)
    if (!match) throw new Error(`monaco-editor's entry no longer imports the ${name} language service as expected.`)
    result = result.replace(match[0], `const ${match[1]} = {};`)
  }
  return result
}

export function monacoLanguageServices({ exclude }: { exclude: readonly string[] }): Plugin {
  return {
    name: "monaco-language-services",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (!ENTRY.test(id)) return
      try {
        return withoutLanguageServices(code, exclude)
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
