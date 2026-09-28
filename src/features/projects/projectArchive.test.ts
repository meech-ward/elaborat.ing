import { describe, expect, test } from "bun:test"
import { zipSync } from "fflate"
import { MemoryProjectDatabase } from "@/features/project-storage/database"
import { ProjectFileStore } from "@/features/project-storage/fileStore"
import { ProjectLibrary } from "@/features/project-storage/library"
import { partitionKey } from "@/features/project-storage/model"
import { FakeProjectServer, OWNER } from "@/features/project-storage/testing"
import { filesToDownload, folderEntries, planArchive, titleFrom, unzipFiles, zipEntries, zipName, zipProject, type ArchiveEntry } from "./projectArchive"
import { importPrototype } from "./prototypeImport"

const encode = (text: string) => new TextEncoder().encode(text)
const MiB = 1024 * 1024

// A project with every kind of file, and bytes that are easy to lose: a byte
// order mark, CRLF, a tab, an emoji, a trailing space, and a file with a name
// JavaScript objects treat specially.
const files = [
  { path: "notes/intro.mdx", content: '﻿import { Badge } from "workspace:components/badge.mdx"\r\n\r\n# Intro\t🙂 <Badge /> ' },
  { path: "components/badge.mdx", content: 'export const Badge = () => <span className="badge">new</span>\n' },
  { path: "drawings/sketch.excalidraw", content: '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}' },
  { path: "diagrams/flow.d2", content: "idea -> draft -> done\n" },
  { path: "diagrams/flow.excalidraw", content: '{"type":"excalidraw","version":2,"elements":[]}' },
  { path: "diagrams/flow.d2.json", content: '{"version":1,"source":"diagrams/flow.d2"}' },
  { path: "data/table.csv", content: "a,b\n1,2\n" },
  { path: "__proto__", content: "a file at the top named __proto__" },
  { path: "empty.md", content: "" },
]
const folders = ["empty-folder", "notes", "deep/er"]

const unzipPlan = (zip: Uint8Array, title = "Round trip") => planArchive(title, zipEntries(zip), async (paths) => unzipFiles(zip, new Set(paths)))

async function planned(title: string, entries: ArchiveEntry[], bytes: Record<string, Uint8Array>) {
  const result = await planArchive(title, entries, async (paths) => new Map(paths.flatMap((path) => (bytes[path] ? [[path, bytes[path]] as const] : []))))
  if (!result.ok) throw new Error(result.error)
  return result.plan
}

function library() {
  const db = new MemoryProjectDatabase()
  const library = new ProjectLibrary(db, new FakeProjectServer().remote(OWNER), partitionKey("https://example.supabase.co", OWNER))
  return { library, filesOf: (id: string) => new ProjectFileStore(db, library.partition, id) }
}

describe("a project as a .zip", () => {
  test("the zip holds each file and explicit folder at its path, and nothing else", () => {
    const zip = zipProject(files, folders)
    const entries = zipEntries(zip)
    expect(entries.map((entry) => entry.path).sort()).toEqual([...files.map((file) => file.path), ...folders].sort())
    expect(entries.filter((entry) => entry.kind === "folder").map((entry) => entry.path).sort()).toEqual([...folders].sort())
    const unpacked = unzipFiles(zip, new Set(files.map((file) => file.path)))
    for (const file of files) expect(unpacked.get(file.path)).toEqual(encode(file.content))
  })

  test("download, import, download again: every file is byte for byte the same", async () => {
    const { library: first, filesOf } = library()
    const result = await unzipPlan(zipProject(files, folders))
    if (!result.ok) throw new Error(result.error)
    expect(result.plan.skipped).toEqual([])
    const id = await importPrototype(first, filesOf, result.plan)
    const snapshot = await filesOf(id).snapshot()
    const imported = filesToDownload(snapshot.files, false)
    expect(imported.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    expect(snapshot.folders.sort()).toEqual([...folders].sort())

    const again = zipProject(imported, snapshot.folders)
    const reread = unzipFiles(again, new Set(files.map((file) => file.path)))
    for (const file of files) expect(reread.get(file.path)).toEqual(encode(file.content))
  })

  test("the import keeps a D2 source with its companions in one save, and splits large projects into saves", async () => {
    const many = Array.from({ length: 1200 }, (_, index) => ({ path: `many/${String(index).padStart(4, "0")}.md`, content: `${index}\n` }))
    const result = await unzipPlan(zipProject([...files, ...many], []))
    if (!result.ok) throw new Error(result.error)
    expect(result.plan.saves.length).toBe(3)
    expect(result.plan.saves.every((save) => save.length <= 500)).toBe(true)
    const withSource = result.plan.saves.find((save) => save.some((file) => file.path === "diagrams/flow.d2"))!
    expect(withSource.map((file) => file.path)).toEqual(expect.arrayContaining(["diagrams/flow.excalidraw", "diagrams/flow.d2.json"]))
  })

  test("unsaved changes are left out unless asked for", () => {
    const stored = [
      { path: "a.md", saved: "saved", draft: "edited" },
      { path: "b.md", saved: "only saved", draft: null },
      { path: "new.md", saved: null, draft: "never saved" },
    ]
    expect(filesToDownload(stored, false)).toEqual([
      { path: "a.md", content: "saved" },
      { path: "b.md", content: "only saved" },
    ])
    expect(filesToDownload(stored, true)).toEqual([
      { path: "a.md", content: "edited" },
      { path: "b.md", content: "only saved" },
      { path: "new.md", content: "never saved" },
    ])
  })

  test("the file is named after the project", () => {
    expect(zipName("Product notes")).toBe("Product notes.zip")
    expect(zipName('Q3: plans/ideas? "draft"')).toBe("Q3- plans-ideas- -draft-.zip")
    expect(zipName("..")).toBe("project.zip")
    expect(zipName("   ")).toBe("project.zip")
  })
})

describe("importing a .zip or a folder", () => {
  test("what this app cannot store is skipped with the reason, and the rest imports", async () => {
    const big = new Uint8Array(2 * MiB + 1).fill(97)
    const plan = await planned(
      "Mixed",
      [
        { kind: "file", path: "ok.md", size: 2 },
        { kind: "file", path: ".git/config", size: 3 },
        { kind: "file", path: "ok.md", size: 5 },
        { kind: "file", path: "big.md", size: big.length },
        { kind: "file", path: "image.png", size: 4 },
        { kind: "file", path: "packed.md", size: 1, problem: "The file is compressed in a way this app cannot read." },
        { kind: "file", path: "notes", size: 1 },
        { kind: "file", path: "notes/inside.md", size: 1 },
        { kind: "folder", path: "notes" },
        { kind: "folder", path: "kept" },
      ],
      { "ok.md": encode("ok"), "big.md": big, "image.png": new Uint8Array([0x89, 0x50, 0xff, 0xfe]), notes: encode("n"), "notes/inside.md": encode("i") },
    )
    expect(plan.saves.flat()).toEqual([
      { path: "notes", content: "n" },
      { path: "ok.md", content: "ok" },
    ])
    expect(plan.directories).toEqual(["kept"])
    expect(plan.skipped).toEqual([
      { path: ".git/config", reason: "A name in the path starts with a dot." },
      { path: "big.md", reason: "The file is larger than 2 MiB." },
      { path: "image.png", reason: "The file is not UTF-8 text, and this app stores only text." },
      { path: "notes/", reason: "A file has this path, so it cannot also be a folder." },
      { path: "notes/inside.md", reason: "notes is a file, so it cannot contain this path." },
      { path: "ok.md", reason: "The path appears more than once." },
      { path: "packed.md", reason: "The file is compressed in a way this app cannot read." },
    ])
  })

  test("a file that says it is small but unpacks larger is still refused", async () => {
    const plan = await planned("Lying", [{ kind: "file", path: "a.md", size: 10 }], { "a.md": new Uint8Array(2 * MiB + 1).fill(97) })
    expect(plan.skipped).toEqual([{ path: "a.md", reason: "The file is larger than 2 MiB." }])
  })

  test("more than a project can hold is refused as a whole", async () => {
    const entries: ArchiveEntry[] = Array.from({ length: 4097 }, (_, index) => ({ kind: "file", path: `f${index}.md`, size: 1 }))
    const result = await planArchive("Too many", entries, async (paths) => new Map(paths.map((path) => [path, encode("x")])))
    expect(result).toEqual({ ok: false, error: "A project can hold at most 4096 files, and this has 4097." })

    const heavy: ArchiveEntry[] = Array.from({ length: 33 }, (_, index) => ({ kind: "file", path: `h${index}.md`, size: 2 * MiB }))
    const block = new Uint8Array(2 * MiB).fill(97)
    const tooBig = await planArchive("Too big", heavy, async (paths) => new Map(paths.map((path) => [path, block])))
    expect(tooBig).toEqual({ ok: false, error: "The files add up to more than 64 MiB, the most a project can hold." })
  })

  test("a file that is not a .zip is refused, and only the files asked for are unpacked", () => {
    expect(() => zipEntries(encode("not a zip at all, just some text that goes on for a while"))).toThrow()
    const zip = zipSync({ "a.md": encode("first") })
    expect(unzipFiles(zip, new Set(["a.md", "missing.md"]))).toEqual(new Map([["a.md", encode("first")]]))
  })

  test("a chosen folder's files are named by their path inside it, and it names the project", () => {
    const file = (relative: string, text: string) => {
      const made = new File([text], relative.split("/").at(-1)!)
      Object.defineProperty(made, "webkitRelativePath", { value: relative })
      return made
    }
    const chosen = folderEntries([file("My notes/a.md", "a"), file("My notes/sub/b.md", "bb")])
    expect(chosen.name).toBe("My notes")
    expect(chosen.entries).toEqual([
      { kind: "file", path: "a.md", size: 1 },
      { kind: "file", path: "sub/b.md", size: 2 },
    ])
    expect(titleFrom(chosen.name)).toBe("My notes")
    expect(titleFrom("Product notes.zip")).toBe("Product notes")
    expect(titleFrom(" .zip")).toBe("Untitled project")
    expect([...titleFrom("x".repeat(200))].length).toBe(160)
  })
})
