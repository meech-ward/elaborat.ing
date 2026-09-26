import type { LocalChange } from "@/features/project-storage/fileStore"
import { MAX_ENTRIES } from "@/features/project-storage/model"
import { diagramPartnerPaths } from "@/features/workspace"
import { findReferences } from "@/features/workspace/moveRefs"
import { holdsReferences, type MoveSourceFile } from "./movePlan"

/** Delete a file (a D2 diagram with its generated files), or a folder with everything in it. */
export type DeleteRequest = { path: string } | { folder: string }

export type DeletePlan = {
  /** The files that go. */
  files: string[]
  /** The folders that go, in order: a deleted folder and every folder in it. */
  folders: string[]
  /** Files that stay but refer to what goes. Their references are left as they are. */
  references: Array<{ path: string; references: Array<{ to: string; line: number }> }>
  /** Reasons the delete cannot go ahead yet. The changes are only safe to save when this is empty. */
  blockers: Array<{ path: string; reason: string }>
  /** The deletes, as one save on this device. */
  changes: LocalChange[]
}

/** The request itself cannot work (a missing file or folder, a generated file, too many changes). */
export class DeleteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeleteRefusedError"
  }
}

const isD2 = (path: string) => /\.d2$/i.test(path)

/**
 * Plan deleting a file or a folder as one save. A D2 diagram's generated
 * files go with it, as in a move; a folder takes every file and folder in
 * it. Files that stay and refer to what goes are listed, not rewritten. A
 * file that goes with unsaved edits or a sync conflict is a blocker. `files`
 * must include every file in the project, with saved contents for those that
 * `holdsReferences`; `folders` lists every folder, and `explicit` the stored
 * ones.
 */
export function planDelete(
  files: readonly MoveSourceFile[],
  folders: readonly string[],
  explicit: readonly string[],
  request: DeleteRequest,
): DeletePlan {
  const byPath = new Map(files.map((file) => [file.path, file]))
  let going: MoveSourceFile[]
  let gone: string[] = []
  let action: string
  let what: string
  if ("path" in request) {
    const source = byPath.get(request.path)
    if (!source) throw new DeleteRefusedError(`${request.path} is not in this project.`)
    const owner = isD2(source.path) ? null : diagramPartnerPaths(source.path).find((path) => isD2(path) && byPath.has(path))
    if (owner) throw new DeleteRefusedError(`${source.path} is generated from ${owner}. Delete ${owner} instead, and its generated files go with it.`)
    const partners = isD2(source.path) ? diagramPartnerPaths(source.path).flatMap((path) => byPath.get(path) ?? []) : []
    going = [source, ...partners]
    action = "deleting it"
    what = source.path
  } else {
    const folder = request.folder
    if (!folders.includes(folder)) throw new DeleteRefusedError(`There is no folder ${folder}.`)
    going = files.filter((file) => file.path.startsWith(`${folder}/`))
    gone = folders.filter((path) => path === folder || path.startsWith(`${folder}/`)).sort()
    action = "deleting its folder"
    what = folder
  }

  const blockers: DeletePlan["blockers"] = []
  for (const file of going) {
    if (file.draft !== null) blockers.push({ path: file.path, reason: `It has unsaved edits. Save or discard them before ${action}.` })
    if (file.conflict) blockers.push({ path: file.path, reason: `It has a sync conflict. Resolve it before ${action}.` })
  }

  const leaving = new Set(going.map((file) => file.path))
  const staying = files.flatMap((file) => (!leaving.has(file.path) && holdsReferences(file.path) && file.saved !== null ? [{ path: file.path, content: file.saved }] : []))
  const references = findReferences(staying, [...leaving])

  // Only stored folders are removed; one that only holds files goes with them.
  const stored = new Set(explicit)
  const changes: LocalChange[] = [
    ...going.map((file): LocalChange => ({ kind: "delete", path: file.path, expectedRevision: file.revision })),
    ...gone.filter((path) => stored.has(path)).reverse().map((path): LocalChange => ({ kind: "rmdir", path })),
  ]
  if (changes.length > MAX_ENTRIES) {
    throw new DeleteRefusedError(
      `Deleting ${what} takes ${changes.length} changes, more than the ${MAX_ENTRIES} one save can hold. Delete some of what is in it first.`,
    )
  }
  return { files: going.map((file) => file.path), folders: gone, references, blockers, changes }
}
