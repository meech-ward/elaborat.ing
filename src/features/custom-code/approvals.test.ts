import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { prepareComponentEnvironment } from "@/features/document/componentModules"
import { approveCode, approvedCode, codeFiles, waitingFiles } from "./approvals"

const chart = (label: string) => `export const Chart = () => <p>${label}</p>\n\nSome words about the chart.\n`
const load = (text: string) => async () => ({ text, revision: "1" })
const note = (body: string) => `import { Chart } from "workspace:ui/chart.mdx"\n\n# Plan\n\n${body}\n\n<Chart />\n`

describe("custom component code", () => {
  test("a note that uses only built-in components runs no custom code", async () => {
    const environment = await prepareComponentEnvironment('# Plan\n\n<Callout>Hi</Callout>\n\nimport { useState } from "react"\n')
    expect(environment.code).toEqual([])
  })

  test("imported component files and the note's own exports are the code it runs", async () => {
    const imported = await prepareComponentEnvironment(note("Words."), load(chart("one")))
    expect(imported.code.map((entry) => entry.path)).toEqual(["ui/chart.mdx"])
    const own = await prepareComponentEnvironment("export const Pill = () => <b>hi</b>\n\n<Pill />\n")
    expect(own.code.map((entry) => entry.path)).toEqual([null])
  })

  test("a new version of a component file is new code; the note's prose is not", async () => {
    const tokens = async (source: string, module: string) => (await codeFiles((await prepareComponentEnvironment(source, load(module))).code, "notes/plan.mdx")).map((file) => file.token)
    const first = await tokens(note("Words."), chart("one"))
    expect(first[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(await tokens(note("Other words."), chart("one"))).toEqual(first)
    // Words in the component file's own body never run when it is imported.
    expect(await tokens(note("Words."), chart("one").replace("Some words", "New words"))).toEqual(first)
    expect(await tokens(note("Words."), chart("two"))).not.toEqual(first)
  })

  test("an expression in the note's text that runs code is the note's own code; a comment or a literal value is not", async () => {
    const own = async (text: string) => (await prepareComponentEnvironment(`# Plan\n\n${text}\n`)).code
    for (const text of ["{/* a comment */}", "{2}", '<Counter initial={-2} label="x" />', "<Chart data={[{ x: 1, y: 'a' }, null]} />", "{`plain`}"]) {
      expect(await own(text)).toEqual([])
    }
    for (const text of ["{(() => 'ran')()}", "{`${1 + 1}`}", "<Counter initial={Math.random()} />", "<Callout {...{ tone: 'warn' }}>Hi</Callout>", "Inline {window.name} too."]) {
      expect((await own(text)).map((entry) => entry.path)).toEqual([null])
    }
    // A changed expression is new code; the words around it are not.
    const tokens = async (text: string) => (await codeFiles(await own(text), "notes/plan.mdx")).map((file) => file.token)
    const first = await tokens("Before {1 + 1} after.")
    expect(await tokens("Other words {1 + 1} here.")).toEqual(first)
    expect(await tokens("Before {1 + 2} after.")).not.toEqual(first)
  })

  test("the note's own exports are its own file, under its path", async () => {
    const environment = await prepareComponentEnvironment("export const Pill = () => <b>hi</b>\n\n<Pill />\n")
    const [file] = await codeFiles(environment.code, "notes/plan.mdx")
    expect(file).toMatchObject({ path: "notes/plan.mdx", own: true })
    const [moved] = await codeFiles(environment.code, "notes/moved.mdx")
    expect(moved.token).not.toBe(file.token)
  })
})

describe("remembered choices", () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    Object.assign(globalThis, {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
      },
    })
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  test("a choice is kept for its project and read back", async () => {
    const files = await codeFiles([{ path: "ui/chart.mdx", esm: "export const Chart = () => null" }], "notes/plan.mdx")
    expect(waitingFiles(files, approvedCode("person:project-a"))).toEqual(files)
    approveCode("person:project-a", files.map((file) => file.token))
    expect(waitingFiles(files, approvedCode("person:project-a"))).toEqual([])
    expect(waitingFiles(files, approvedCode("person:project-b"))).toEqual(files)
    // Only the hashes are stored.
    expect(JSON.parse(saved.get("elaborating.run-components.v1:person:project-a") ?? "[]")).toEqual([files[0].token])
  })

  test("a stored list that is not a list of hashes counts as no choices", () => {
    saved.set("elaborating.run-components.v1:person:project-c", JSON.stringify(["not a hash"]))
    expect(approvedCode("person:project-c").size).toBe(0)
    saved.set("elaborating.run-components.v1:person:project-d", "{")
    expect(approvedCode("person:project-d").size).toBe(0)
  })
})
