import { describe, expect, test } from "bun:test"
import { MemoryProjectDatabase } from "@/features/project-storage/database"
import { ProjectFileStore } from "@/features/project-storage/fileStore"
import { ProjectLibrary } from "@/features/project-storage/library"
import { partitionKey, type SaveChange } from "@/features/project-storage/model"
import { FakeProjectServer, OWNER } from "@/features/project-storage/testing"
import { PrototypeExport, SAVE_BYTES, SAVE_FILES, importPrototype, planImport, readPrototypeExport } from "./prototypeImport"

const exported = (overrides: Record<string, unknown> = {}) => ({
  format: "diagramming-project",
  version: 1,
  title: "Notes",
  files: [{ path: "notes/intro.mdx", content: "# Intro\n" }],
  directories: ["notes", "empty-folder"],
  ...overrides,
})
const read = (value: unknown) => readPrototypeExport(JSON.stringify(value))
const errorOf = (value: unknown) => {
  const result = read(value)
  if (result.ok) throw new Error("expected the export to be refused")
  return result.error
}
const MiB = 1024 * 1024

describe("reading an export", () => {
  test("a valid export reads as it was written", () => {
    const content = 'import { Card } from "workspace:components/card.mdx"\r\n\r\n<Card />\t🙂'
    const result = read(exported({ files: [{ path: "notes/intro.mdx", content }] }))
    expect(result).toEqual({ ok: true, value: exported({ files: [{ path: "notes/intro.mdx", content }] }) as PrototypeExport })
  })

  test("the wrong format or version is refused", () => {
    expect(errorOf(exported({ format: "elaborating" }))).toContain('its "format" is not "diagramming-project"')
    expect(errorOf(exported({ version: 2 }))).toBe("Only version 1 of the prototype's export can be imported.")
    expect(readPrototypeExport("{ not json").ok).toBe(false)
    expect(errorOf(exported({ extra: true }))).toContain('Unrecognized key: "extra"')
    expect(errorOf(exported({ files: [{ path: "a.md", content: 1 }] }))).toContain("at files[0].content")
  })

  test("the title needs 1 to 160 characters with some text", () => {
    expect(read(exported({ title: "🙂".repeat(160) })).ok).toBe(true)
    for (const title of ["", "   ", "x".repeat(161)]) expect(errorOf(exported({ title }))).toContain("1 to 160 characters")
  })

  test("a path twice, or a file used as a folder, is refused", () => {
    expect(errorOf(exported({ files: [{ path: "a.md", content: "1" }, { path: "a.md", content: "2" }] }))).toBe("a.md appears more than once.")
    expect(errorOf(exported({ directories: ["notes", "notes"] }))).toBe("notes appears more than once.")
    expect(errorOf(exported({ directories: ["notes/intro.mdx"] }))).toBe("notes/intro.mdx is a file, so it cannot also be a folder.")
    expect(errorOf(exported({ files: [{ path: "a.md", content: "" }, { path: "a.md/b.md", content: "" }] }))).toBe(
      "a.md is a file, so it cannot contain a.md/b.md.",
    )
  })

  test("too many entries, a file over 2 MiB, or more than 64 MiB in all is refused", () => {
    const many = Array.from({ length: 4097 }, (_, index) => `folder-${index}`)
    expect(errorOf(exported({ directories: many }))).toBe("An export can hold at most 4096 folders.")
    const big = "x".repeat(2 * MiB)
    expect(PrototypeExport.safeParse(exported({ files: [{ path: "big.md", content: big + "x" }] })).error?.issues[0].message).toBe(
      "big.md is larger than 2 MiB.",
    )
    const files = Array.from({ length: 33 }, (_, index) => ({ path: `f${index}.md`, content: big }))
    expect(PrototypeExport.safeParse(exported({ files })).error?.issues.map((issue) => issue.message)).toEqual(["The files add up to more than 64 MiB."])
  })

  test("many problems are summed up after the first three", () => {
    const files = Array.from({ length: 5 }, () => ({ path: "same.md", content: "" }))
    expect(errorOf(exported({ files }))).toBe(
      "same.md appears more than once. same.md appears more than once. same.md appears more than once. There are 1 more problems.",
    )
  })
})

describe("planning an import", () => {
  test("paths this app cannot store are skipped, each with its reason", () => {
    const plan = planImport(
      PrototypeExport.parse(
        exported({
          files: [
            { path: "notes/intro.mdx", content: "# Intro\n" },
            { path: "notes/café.md", content: "not NFC" },
            { path: ".obsidian/app.json", content: "{}" },
            { path: "a:b.md", content: "colon" },
            { path: "tab\there.md", content: "control" },
            { path: `${"x".repeat(1025)}.md`, content: "long" },
          ],
          directories: ["notes", "empty-folder", "a//b", "/rooted"],
        }),
      ),
    )
    expect(plan.saves).toEqual([[{ path: "notes/intro.mdx", content: "# Intro\n" }]])
    expect(plan.directories).toEqual(["empty-folder", "notes"])
    expect(plan.skipped).toEqual([
      { path: "notes/café.md", reason: "The path is not in Unicode normal form C (NFC)." },
      { path: ".obsidian/app.json", reason: "A name in the path starts with a dot." },
      { path: "a:b.md", reason: "The path has a backslash or a colon." },
      { path: "tab\there.md", reason: "The path has a control character." },
      { path: `${"x".repeat(1025)}.md`, reason: "The path is longer than 1024 bytes." },
      { path: "a//b", reason: "The path has an empty folder name (two slashes in a row)." },
      { path: "/rooted", reason: "The path starts or ends with a slash." },
    ])
  })

  test("saves hold at most 500 files and 8 MiB, and keep a D2 source with its companions", () => {
    const files = [
      ...Array.from({ length: 499 }, (_, index) => ({ path: `a/${String(index).padStart(3, "0")}.md`, content: "a" })),
      { path: "b/flow.d2", content: "x -> y" },
      { path: "b/flow.d2.json", content: "{}" },
      { path: "b/flow.excalidraw", content: "{}" },
      ...Array.from({ length: 5 }, (_, index) => ({ path: `c/${index}.md`, content: "y".repeat(2 * MiB) })),
    ]
    const plan = planImport(PrototypeExport.parse(exported({ files, directories: [] })))
    expect(plan.saves.map((save) => save.length)).toEqual([499, 6, 2])
    expect(plan.saves[1].slice(0, 3).map((file) => file.path).sort()).toEqual(["b/flow.d2", "b/flow.d2.json", "b/flow.excalidraw"])
    for (const save of plan.saves) {
      expect(save.length).toBeLessThanOrEqual(SAVE_FILES)
      expect(save.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0)).toBeLessThanOrEqual(SAVE_BYTES)
    }
    expect(plan.saves.flat().map((file) => file.path).sort()).toEqual(files.map((file) => file.path).sort())
  })
})

test("an import creates the project on this device, and each sync is one small save_files call", async () => {
  const server = new FakeProjectServer()
  const db = new MemoryProjectDatabase()
  const partition = partitionKey("https://example.supabase.co", OWNER)
  const library = new ProjectLibrary(db, server.remote(OWNER), partition)
  const files = [
    ...Array.from({ length: 1100 }, (_, index) => ({ path: `notes/${index}.md`, content: `note ${index}\r\n` })),
    { path: "notes/intro.mdx", content: 'import { Card } from "workspace:components/card.mdx"\n\n<Card />' },
    { path: "diagrams/flow.d2", content: "a -> b\n" },
    { path: "diagrams/flow.d2.json", content: '{"version":1}' },
    { path: "diagrams/flow.excalidraw", content: '{"type":"excalidraw"}' },
  ]
  const plan = planImport(PrototypeExport.parse(exported({ title: "Imported", files, directories: ["notes", "diagrams", "empty-folder"] })))

  const projectId = await importPrototype(library, (id) => new ProjectFileStore(db, partition, id), plan)
  expect(library.getState().entries.find((entry) => entry.id === projectId)).toMatchObject({ title: "Imported", status: "unsynced" })
  expect((await library.syncProject(projectId)).status).toBe("synced")

  for (const file of files) expect(server.content(projectId, file.path)).toBe(file.content)
  expect([...server.projects.get(projectId)!.folders].sort()).toEqual(["diagrams", "empty-folder", "notes"])
  const batches = server.calls.filter((call) => call.method === "saveFiles").map((call) => call.args[2] as SaveChange[])
  const fileBatches = batches.filter((changes) => changes.some((change) => change.op === "put"))
  expect(fileBatches.length).toBe(plan.saves.length)
  expect(Math.max(...fileBatches.map((changes) => changes.length))).toBeLessThanOrEqual(SAVE_FILES)
  const flow = fileBatches.find((changes) => changes.some((change) => change.path === "diagrams/flow.d2"))!
  expect(flow.map((change) => change.path).filter((path) => path.startsWith("diagrams/")).sort()).toEqual([
    "diagrams/flow.d2",
    "diagrams/flow.d2.json",
    "diagrams/flow.excalidraw",
  ])
})
