import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { COMPONENT_CATALOG } from "@/features/document/componentCatalog"
import { PREVIEW_COMPONENTS } from "../preview/catalog"
import { compileComponents, compileNote } from "../preview/compile"
import { frameDocument, inlineScript } from "../preview/frameDocument"
import { MAX_MESSAGE, readFrameMessage } from "../preview/frameMessages"
import { parseShowResult } from "../toolResult"

const CHART = [
  "import { Axis } from 'workspace:components/axis.mdx'",
  "",
  "export const componentMeta = { Chart: { props: { title: { type: 'string', default: 'Visitors' }, bars: { type: 'number', default: 3 } } } }",
  "",
  "export const Chart = ({ title, bars }) => <figure><figcaption>{title}</figcaption><Axis count={bars} /></figure>",
  "",
  "export function Legend() { return <p>Legend</p> }",
].join("\n")
const AXIS = "export const Axis = ({ count }) => <span>{count} bars</span>\n"
const SOURCES = { "components/chart.mdx": CHART, "components/axis.mdx": AXIS }

describe("what the card compiles", () => {
  test("a note compiles with the component files it imports, each after its own imports", async () => {
    const program = await compileNote("import { Chart } from 'workspace:components/chart.mdx'\n\n# Plan\n\n<Chart title=\"Q3\" />\n", SOURCES)
    expect(program.modules.map((module) => module.path)).toEqual(["components/axis.mdx", "components/chart.mdx"])
    expect(program.note).toContain("workspaceModules")
    expect(program.items).toBeNull()
    // Plain JavaScript for an ordinary script: no eval, no new Function, no import statements.
    for (const code of [program.note!, ...program.modules.map((module) => module.code)]) {
      expect(code).not.toMatch(/\beval\(|new Function|^\s*import\s/m)
    }
  })

  test("each outermost element is wrapped in the guard, and nothing inside one is", async () => {
    const program = await compileNote("<Tabs>\n  <Tab name=\"A\">\n\nOne <Badge>new</Badge>\n\n  </Tab>\n</Tabs>\n\nText with <Badge>inline</Badge>.\n", {})
    const guards = [...program.note!.matchAll(/_components\.PreviewGuard|PreviewGuard\b/g)].length
    expect(guards).toBeGreaterThan(0)
    expect(program.note).toContain('name: "Tabs"')
    expect(program.note).toContain('name: "Badge"')
    // The Badge inside the Tab is not guarded on its own: Tabs reads its children's types.
    expect(program.note!.match(/name: "Badge"/g)?.length).toBe(1)
    expect(program.note).toContain("inline: true")
  })

  test("a note fails with the app's messages: a missing file, a reserved name, broken MDX", async () => {
    await expect(compileNote("import { Gone } from 'workspace:components/gone.mdx'\n", {})).rejects.toThrow("No component file at components/gone.mdx.")
    await expect(compileNote("export const Callout = () => null\n", {})).rejects.toThrow("Component name Callout is reserved")
    await expect(compileNote("# Plan\n\n<Chart\n", {})).rejects.toThrow()
  })

  test("a component file shows each component with its componentMeta defaults, or one with the props given", async () => {
    const every = await compileComponents("components/chart.mdx", SOURCES, { component: null, props: null })
    expect(every.target).toBe("components/chart.mdx")
    expect(every.items).toEqual([
      { name: "Chart", props: { title: "Visitors", bars: 3 } },
      { name: "Legend", props: {} },
    ])
    expect(every.modules.map((module) => module.path)).toEqual(["components/axis.mdx", "components/chart.mdx"])
    const one = await compileComponents("components/chart.mdx", SOURCES, { component: "Chart", props: { title: "Q3" } })
    expect(one.items).toEqual([{ name: "Chart", props: { title: "Q3" } }])
  })

  test("a component file without that component, or without any, says so", async () => {
    await expect(compileComponents("components/chart.mdx", SOURCES, { component: "Pie", props: null })).rejects.toThrow("components/chart.mdx exports no component named Pie.")
    await expect(compileComponents("components/none.mdx", { "components/none.mdx": "# Just text\n" }, { component: null, props: null })).rejects.toThrow("exports no components")
    await expect(compileComponents("../x.mdx", {}, { component: null, props: null })).rejects.toThrow("Unsafe workspace component path")
  })
})

describe("the frame's document", () => {
  test("the compiled code runs as inline scripts that cannot end their element early", () => {
    expect(inlineScript('const a = "</script><script>alert(1)</script>"; const b = /<!--/')).toBe(
      'const a = "<\\/script><script>alert(1)<\\/script>"; const b = /<\\u0021--/',
    )
    const html = frameDocument({
      runtime: "var elaboratingPreview={open(){}}",
      style: ":root{}",
      program: { modules: [{ path: "a.mdx", code: 'return {x: "</SCRIPT>"}' }], note: "return {}", target: null, items: null },
      run: 7,
      scheme: "dark",
    })
    expect(html).toStartWith('<!doctype html><html lang="en" data-scheme="dark" class="dark">')
    expect(html.match(/<script>/g)?.length).toBe(4)
    expect(html.match(/<\/script>/gi)?.length).toBe(4)
    expect(html).toContain("<script>var preview=elaboratingPreview.open(7)</script>")
    expect(html).toContain("<script>preview.module(0,async function(){\nreturn {x: \"<\\/SCRIPT>\"}\n})</script>")
    expect(html).toContain("<script>preview.note(async function(){\nreturn {}\n})</script>")
  })

  test("with no scheme from the host, the frame follows the device", () => {
    const html = frameDocument({ runtime: "", style: "", program: { modules: [], note: null, target: "a.mdx", items: [] }, run: 1, scheme: null })
    expect(html).toStartWith('<!doctype html><html lang="en"><head>')
  })
})

describe("what the frame says to the card", () => {
  test("only the known messages, with their text cut short", () => {
    expect(readFrameMessage({ type: "size", run: 1, height: 240 })).toEqual({ type: "size", run: 1, height: 240 })
    expect(readFrameMessage({ type: "rendered", run: 1, errors: [{ name: "Chart", message: "boom" }] })).toEqual({
      type: "rendered",
      run: 1,
      errors: [{ name: "Chart", message: "boom" }],
    })
    const failed = readFrameMessage({ type: "failed", run: 1, message: "x".repeat(1000) })
    expect(failed?.type === "failed" && failed.message.length).toBe(MAX_MESSAGE)
    for (const junk of [null, "ready", { type: "ready" }, { type: "size", run: 1, height: -1 }, { type: "tools/call", run: 1 }, { jsonrpc: "2.0", method: "tools/call" }]) {
      expect(readFrameMessage(junk)).toBeNull()
    }
  })
})

test("the frame gives a note every component of the app's catalog", () => {
  for (const { name } of COMPONENT_CATALOG) {
    if (name === "Drawing" || name === "Diagram") continue
    const [root, part] = name.split(".")
    const provided = PREVIEW_COMPONENTS[root] as Record<string, unknown> | undefined
    expect(provided, name).toBeDefined()
    if (part) expect(provided?.[part], name).toBeDefined()
  }
})

describe("the results the card previews", () => {
  const base = { project_id: "p", version: 3, url: "https://elaborat.ing/projects/p/x", truncated: false, embeds: [] }
  const modules = { "components/chart.mdx": CHART }

  test("a whole MDX note with component files, and a component file with its request", () => {
    const note = parseShowResult({
      structuredContent: { ...base, path: "notes/plan.mdx", kind: "note" },
      _meta: { "elaborat.ing/html": "<h1>Plan</h1>", "elaborat.ing/source": "# Plan", "elaborat.ing/components": { modules } },
    })
    expect(note.ok && [note.file.components, note.file.preview]).toEqual([modules, null])
    const component = parseShowResult({
      structuredContent: { ...base, path: "components/chart.mdx", kind: "component", draft: true, component: "Chart", props: { title: "Q3" } },
      _meta: { "elaborat.ing/components": { modules } },
    })
    expect(component.ok && [component.file.kind, component.file.components, component.file.preview, component.file.source]).toEqual([
      "component",
      modules,
      { component: "Chart", props: { title: "Q3" }, draft: true },
      null,
    ])
  })

  test("a note cut short, or component files that are not text, are not previewed", () => {
    const cut = parseShowResult({
      structuredContent: { ...base, path: "notes/plan.mdx", kind: "note", truncated: true },
      _meta: { "elaborat.ing/html": "<h1>Plan</h1>", "elaborat.ing/source": "# Plan", "elaborat.ing/components": { modules } },
    })
    expect(cut.ok && cut.file.components).toBeNull()
    const odd = parseShowResult({
      structuredContent: { ...base, path: "notes/plan.mdx", kind: "note" },
      _meta: { "elaborat.ing/source": "# Plan", "elaborat.ing/components": { modules: { "a.mdx": 3 } } },
    })
    expect(odd.ok && odd.file.components).toBeNull()
  })
})

test("the preview's words have no em dashes", () => {
  for (const name of ["cardNote.tsx", "embedText.ts", "preview/catalog.tsx", "preview/ComponentPreview.tsx", "preview/compile.ts", "preview/runtime.tsx"]) {
    expect(readFileSync(new globalThis.URL(`../${name}`, import.meta.url), "utf8")).not.toContain("—")
  }
})
