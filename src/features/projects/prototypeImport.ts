import { z } from "zod"
import type { ProjectFileStore } from "@/features/project-storage/fileStore"
import type { ProjectLibrary } from "@/features/project-storage/library"
import {
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_PROJECT_BYTES,
  byteLength,
  companionPaths,
  projectPathProblem,
} from "@/features/project-storage/model"

/**
 * A project exported from the prototype that elaborat.ing grew from, as one
 * JSON file. `format` keeps the prototype's name. The limits are the
 * prototype's: a title of 1 to 160 characters with some text, at most 4096
 * files and 4096 folders, no path twice, no file used as a folder, at most
 * 2 MiB per file and 64 MiB in all. Its path rule is looser than this app's,
 * so paths are checked when the import is planned, not here.
 */
export const PrototypeExport = z
  .strictObject({
    format: z.literal("diagramming-project", {
      error: 'This is not a project exported from the prototype: its "format" is not "diagramming-project".',
    }),
    version: z.literal(1, { error: "Only version 1 of the prototype's export can be imported." }),
    title: z
      .string({ error: "The project title must be text." })
      .refine(
        (title) => [...title].length >= 1 && [...title].length <= 160 && /\S/.test(title),
        "The project title must have 1 to 160 characters, and not only spaces.",
      ),
    files: z
      .array(z.strictObject({ path: z.string(), content: z.string() }))
      .max(MAX_ENTRIES, `An export can hold at most ${MAX_ENTRIES} files.`),
    directories: z.array(z.string()).max(MAX_ENTRIES, `An export can hold at most ${MAX_ENTRIES} folders.`),
  })
  .superRefine((exported, context) => {
    const problem = (message: string) => context.addIssue({ code: "custom", message })
    const files = new Set<string>()
    for (const { path } of exported.files) {
      if (files.has(path)) problem(`${path} appears more than once.`)
      files.add(path)
    }
    const folders = new Set<string>()
    for (const path of exported.directories) {
      if (folders.has(path)) problem(`${path} appears more than once.`)
      else if (files.has(path)) problem(`${path} is a file, so it cannot also be a folder.`)
      folders.add(path)
    }
    for (const path of [...files, ...folders]) {
      const file = ancestors(path).find((ancestor) => files.has(ancestor))
      if (file !== undefined) problem(`${file} is a file, so it cannot contain ${path}.`)
    }
    let total = 0
    for (const { path, content } of exported.files) {
      const size = byteLength(content)
      if (size > MAX_FILE_BYTES) problem(`${path} is larger than 2 MiB.`)
      total += size
    }
    if (total > MAX_PROJECT_BYTES) problem("The files add up to more than 64 MiB.")
  })
export type PrototypeExport = z.infer<typeof PrototypeExport>

const ancestors = (path: string): string[] => {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/** Where an issue is, such as `files[2].content`. */
const where = (path: PropertyKey[]) =>
  path.map((key, index) => (typeof key === "number" ? `[${key}]` : `${index ? "." : ""}${String(key)}`)).join("")

function describe(issue: z.core.$ZodIssue): string {
  // The checks above, the first three fields and the size limits carry their own messages.
  const top = issue.path.length === 1 ? String(issue.path[0]) : null
  if (issue.code === "custom" || ["format", "version", "title"].includes(top ?? "") || (top && issue.code === "too_big")) return issue.message
  return `The file does not match the export format at ${where(issue.path) || "its top level"}: ${issue.message}`
}

/** Read an export, or say in a sentence or two why it cannot be imported. */
export function readPrototypeExport(text: string): { ok: true; value: PrototypeExport } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: "This file is not valid JSON, so it is not a project export." }
  }
  const parsed = PrototypeExport.safeParse(json)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues.map(describe)
  const more = issues.length > 3 ? ` There are ${issues.length - 3} more problems.` : ""
  return { ok: false, error: `${issues.slice(0, 3).join(" ")}${more}` }
}

export type ImportedFile = { path: string; content: string }

export type ImportPlan = {
  title: string
  /** Local saves, each at most 500 files and 8 MiB, with a D2 source and its companions in the same one. */
  saves: ImportedFile[][]
  directories: string[]
  /** Paths this app cannot store, with the reason for each. */
  skipped: Array<{ path: string; reason: string }>
}

export const SAVE_FILES = 500
export const SAVE_BYTES = 8 * 1024 * 1024

/** Decide what to import, and in which saves. File contents stay exactly as exported. */
export function planImport(exported: PrototypeExport): ImportPlan {
  const skipped: ImportPlan["skipped"] = []
  const usable = (path: string) => {
    const reason = projectPathProblem(path)
    if (reason !== null) skipped.push({ path, reason })
    return reason === null
  }
  const files = exported.files.filter((file) => usable(file.path)).sort((a, b) => (a.path < b.path ? -1 : 1))
  const directories = exported.directories.filter(usable).sort()

  const byPath = new Map(files.map((file) => [file.path, file]))
  const placed = new Set<string>()
  const saves: ImportedFile[][] = []
  let bytes = 0
  for (const file of files) {
    if (placed.has(file.path)) continue
    const group = [file, ...companionPaths(file.path).flatMap((path) => byPath.get(path) ?? [])].filter((member) => !placed.has(member.path))
    const size = group.reduce((sum, member) => sum + byteLength(member.content), 0)
    const current = saves.at(-1)
    if (!current || current.length + group.length > SAVE_FILES || bytes + size > SAVE_BYTES) {
      saves.push([...group])
      bytes = size
    } else {
      current.push(...group)
      bytes += size
    }
    for (const member of group) placed.add(member.path)
  }
  return { title: exported.title, saves, directories, skipped }
}

/**
 * Create the project on this device and write the plan into it. The project
 * reaches the server on its next sync, one `save_files` call per local save.
 */
export async function importPrototype(
  library: ProjectLibrary,
  filesOf: (projectId: string) => ProjectFileStore,
  plan: ImportPlan,
): Promise<string> {
  const projectId = await library.create(plan.title)
  const store = filesOf(projectId)
  for (const save of plan.saves) {
    await store.save(save.map(({ path, content }) => ({ kind: "write" as const, path, content, expectedRevision: null })))
  }
  await store.createDirectories(plan.directories)
  await library.load()
  return projectId
}
