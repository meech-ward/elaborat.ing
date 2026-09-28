import { unzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate"
import { MAX_ENTRIES, MAX_FILE_BYTES, MAX_PROJECT_BYTES, projectPathProblem } from "@/features/project-storage/model"
import { planImport, type ImportPlan } from "./prototypeImport"

/**
 * A project as a .zip and back: the files in their folders, each exactly as
 * saved (UTF-8, no byte order mark added or removed), and a folder entry for
 * each explicit folder. Nothing else goes in the zip. No React, no browser
 * storage: the callers read the device's copy and save the result.
 */

const encoder = new TextEncoder()
// Fatal, so a file that is not UTF-8 text is refused rather than changed, and a leading byte order mark is kept.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** A .zip of these files and folders, paths as they are in the project. */
export function zipProject(files: ReadonlyArray<{ path: string; content: string }>, folders: readonly string[]): Uint8Array<ArrayBuffer> {
  // fflate's streaming writer, which takes any name (its one-call zipSync keeps names as object keys, and loses __proto__).
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, chunk) => {
    if (error) failure = error
    else chunks.push(chunk)
  })
  for (const folder of [...folders].sort()) {
    const entry = new ZipPassThrough(`${folder}/`)
    zip.add(entry)
    entry.push(new Uint8Array(0), true)
  }
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const entry = new ZipDeflate(file.path, { level: 6 })
    zip.add(entry)
    entry.push(encoder.encode(file.content), true)
  }
  zip.end()
  if (failure) throw failure
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** The files to download: the saved copies, or with `drafts` the unsaved edits where a file has some. */
export function filesToDownload(files: ReadonlyArray<{ path: string; saved: string | null; draft: string | null }>, drafts: boolean) {
  return files.flatMap(({ path, saved, draft }) => {
    const content = drafts ? (draft ?? saved) : saved
    return content === null ? [] : [{ path, content }]
  })
}

/** The download's name: the project's title, without characters file systems refuse, and .zip. */
export function zipName(title: string): string {
  const name = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .trim()
    .replace(/^\.+/, "")
  return `${name || "project"}.zip`
}

/** A file or an explicit folder found in a .zip or a chosen folder, before its contents are read. */
export type ArchiveEntry =
  | { kind: "file"; path: string; size: number; problem?: string }
  | { kind: "folder"; path: string }

export type Skipped = ImportPlan["skipped"][number]

/**
 * What a .zip holds, from its central directory, without unpacking
 * anything. Throws when the file is not a .zip.
 */
export function zipEntries(zip: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  unzipSync(zip, {
    filter: (info) => {
      if (info.name.endsWith("/")) entries.push({ kind: "folder", path: info.name.slice(0, -1) })
      else {
        const readable = info.compression === 0 || info.compression === 8
        entries.push({ kind: "file", path: info.name, size: info.originalSize, ...(readable ? {} : { problem: "The file is compressed in a way this app cannot read." }) })
      }
      return false
    },
  })
  return entries
}

/** Unpack these files from a .zip, taking the first entry when a name appears twice. */
export function unzipFiles(zip: Uint8Array, paths: ReadonlySet<string>): Map<string, Uint8Array> {
  const taken = new Set<string>()
  const unpacked = unzipSync(zip, {
    filter: (info) => {
      if (!paths.has(info.name) || taken.has(info.name)) return false
      taken.add(info.name)
      return true
    },
  })
  const found = new Map<string, Uint8Array>()
  for (const path of taken) {
    // fflate collects files in a plain object, where the key __proto__ sets the prototype instead.
    const bytes = path === "__proto__" ? (Object.getPrototypeOf(unpacked) as Uint8Array) : unpacked[path]
    if (bytes instanceof Uint8Array) found.set(path, bytes)
  }
  return found
}

/** The files a chosen folder holds, by their path inside it (the folder's own name removed). */
export function folderEntries(files: readonly File[]): { name: string; entries: ArchiveEntry[]; byPath: Map<string, File> } {
  const byPath = new Map<string, File>()
  const entries: ArchiveEntry[] = []
  let name = ""
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name
    const slash = relative.indexOf("/")
    name ||= slash > 0 ? relative.slice(0, slash) : ""
    const path = slash > 0 ? relative.slice(slash + 1) : relative
    entries.push({ kind: "file", path, size: file.size })
    if (!byPath.has(path)) byPath.set(path, file)
  }
  return { name, entries, byPath }
}

/** A project title from a file or folder name: at most 160 characters, never only spaces. */
export function titleFrom(name: string): string {
  const title = [...name.replace(/\.zip$/i, "").trim()].slice(0, 160).join("").trim()
  return title || "Untitled project"
}

const ancestors = (path: string): string[] => {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/** How much one read asks for, by the sizes the entries declare; what is not text is let go before the next read. */
const READ_BATCH_BYTES = 16 * 1024 * 1024

/**
 * Decide what to import from a .zip or a folder: entries this app cannot
 * store are skipped with the reason (a path it refuses, a name used twice, a
 * file over 2 MiB or not UTF-8 text, a file where a folder has to be); the
 * rest is split into saves as the prototype import does. `read` unpacks the
 * files that pass the checks on paths and sizes, a batch at a time in path
 * order. Refused as a whole when what is left is over the project limits,
 * and reading stops as soon as it is, so a huge folder or .zip is not held
 * in memory whole.
 */
export async function planArchive(
  title: string,
  entries: readonly ArchiveEntry[],
  read: (paths: string[]) => Promise<Map<string, Uint8Array>>,
): Promise<{ ok: true; plan: ImportPlan } | { ok: false; error: string }> {
  const skipped: Skipped[] = []
  const skip = (path: string, reason: string) => skipped.push({ path, reason })
  const files: Array<{ path: string; size: number }> = []
  const folders = new Set<string>()
  const seen = new Set<string>()
  for (const entry of entries) {
    const problem = projectPathProblem(entry.path)
    if (problem) {
      skip(entry.path, problem)
      continue
    }
    if (entry.kind === "folder") {
      folders.add(entry.path)
      continue
    }
    if (seen.has(entry.path)) skip(entry.path, "The path appears more than once.")
    else if (entry.problem) skip(entry.path, entry.problem)
    else if (entry.size > MAX_FILE_BYTES) skip(entry.path, "The file is larger than 2 MiB.")
    else files.push(entry)
    seen.add(entry.path)
  }

  // Path order puts a file before every path inside it. A file cannot sit
  // inside another file, so the shorter path wins.
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const kept: Array<{ path: string; content: string }> = []
  const keptPaths = new Set<string>()
  let total = 0
  for (let start = 0; start < files.length; ) {
    let end = start + 1
    let size = files[start].size
    while (end < files.length && size + files[end].size <= READ_BATCH_BYTES) size += files[end++].size
    const batch = files.slice(start, end).map((file) => file.path)
    start = end
    const bytes = await read(batch)
    for (const path of batch) {
      const data = bytes.get(path)
      if (!data) {
        skip(path, "The file could not be read.")
        continue
      }
      if (data.length > MAX_FILE_BYTES) {
        skip(path, "The file is larger than 2 MiB.")
        continue
      }
      let content: string
      try {
        content = decoder.decode(data)
      } catch {
        skip(path, "The file is not UTF-8 text, and this app stores only text.")
        continue
      }
      const file = ancestors(path).find((ancestor) => keptPaths.has(ancestor))
      if (file !== undefined) {
        skip(path, `${file} is a file, so it cannot contain this path.`)
        continue
      }
      kept.push({ path, content })
      keptPaths.add(path)
      total += data.length
      if (kept.length > MAX_ENTRIES) return { ok: false, error: `A project can hold at most ${MAX_ENTRIES} files, and this has more than that.` }
      if (total > MAX_PROJECT_BYTES) return { ok: false, error: "The files add up to more than 64 MiB, the most a project can hold." }
    }
  }

  // A file wins over a folder with its path.
  const directories = [...folders].filter((path) => {
    const file = [...ancestors(path), path].find((ancestor) => keptPaths.has(ancestor))
    if (file === path) skip(`${path}/`, "A file has this path, so it cannot also be a folder.")
    else if (file !== undefined) skip(`${path}/`, `${file} is a file, so it cannot contain this folder.`)
    return file === undefined
  })
  if (directories.length > MAX_ENTRIES) return { ok: false, error: `A project can hold at most ${MAX_ENTRIES} folders, and this has ${directories.length}.` }

  const plan = planImport({ title, files: kept, directories })
  const all = [...skipped, ...plan.skipped].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ok: true, plan: { ...plan, skipped: all } }
}
