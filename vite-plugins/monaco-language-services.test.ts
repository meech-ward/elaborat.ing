import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { withoutLanguageServices } from "./monaco-language-services"

const entry = fs.readFileSync(path.resolve(import.meta.dir, "../node_modules/monaco-editor/esm/vs/index.js"), "utf8")

test("the installed Monaco entry loses exactly the named language services", () => {
  const result = withoutLanguageServices(entry, ["typescript", "css", "html"])
  for (const name of ["typescript", "css", "html"]) {
    expect(result).not.toContain(`./languages/features/${name}/register.js`)
    // The name is still exported, so the entry keeps its shape.
    expect(result).toMatch(new RegExp(`export \\{ \\w+ as ${name} \\};`))
  }
  expect(result).toContain("./languages/features/json/register.js")
  expect(result).toContain("./languages/definitions/typescript/register.js")
  expect(result.split("\n").length).toBe(entry.split("\n").length)
})

test("a service Monaco no longer imports that way stops the build", () => {
  expect(() => withoutLanguageServices(entry, ["python"])).toThrow("no longer imports the python language service")
})
