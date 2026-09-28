import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The MCP server re-anchors comments with the same code as the app. The Edge
// Functions deploy without building the app and resolve packages with `npm:`
// specifiers, so they use committed copies of these modules. Each copy is its
// source with a first line saying so and Deno's import specifiers.

const COPIES = ["anchoring", "placement"]

/** A copy's text as its source would read: without its first line, with the app's import specifiers. */
function asSource(copy: string): string {
  return copy
    .replace(/^\/\/ A copy of .*\n/, "")
    .replace('from "npm:approx-string-match@2.0.0"', 'from "approx-string-match"')
    .replaceAll('from "./anchoring.ts"', 'from "./anchoring"')
}

for (const name of COPIES) {
  test(`supabase/functions/_shared/comments/${name}.ts is a copy of ${name}.ts`, () => {
    const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8")
    const copy = readFileSync(new URL(`../../../supabase/functions/_shared/comments/${name}.ts`, import.meta.url), "utf8")
    expect(copy.startsWith(`// A copy of src/features/comments/${name}.ts`)).toBe(true)
    expect(asSource(copy)).toBe(source)
  })
}
