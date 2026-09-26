import type { LocalChange } from "@/features/project-storage/fileStore"
import { isValidProjectPath } from "@/features/project-storage/model"
import { basenameForPath, diagramPartnerPaths, renameDestinationPath, validateWorkspacePath } from "@/features/workspace"
import { planMoveReferences, type MoveReferenceFile } from "@/features/workspace/moveRefs"
import { ancestorsOf } from "./folderTree"

/** A file in the project, as the move planner sees it. */
export type MoveSourceFile = {
  path: string
  /** Token of the saved copy, or "" when the file has never been saved. */
  revision: string
  /** The saved copy, or null when there is none. */
  saved: string | null
  /** Unsaved edits kept on this device, or null. */
  draft: string | null
  /** A sync conflict on this file is waiting to be resolved. */
  conflict: boolean
}

/** Move a file into a folder ("" is the project's top level), or rename it where it is. */
export type MoveRequest = { path: string; folder: string } | { path: string; name: string }

export type MoveReference = { from: string; to: string; line: number }

export type MovePlan = {
  moves: Array<{ from: string; to: string }>
  /** Files whose references change. A moved file is listed under its old path. */
  updates: Array<{ path: string; references: MoveReference[] }>
  /** Reasons the move cannot go ahead yet. The changes are only safe to save when this is empty. */
  blockers: Array<{ path: string; reason: string }>
  /** The moves and rewritten files, as one save on this device. */
  changes: LocalChange[]
}

/** The request itself cannot work (a missing file, a bad name, a taken destination). */
export class MoveRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MoveRefusedError"
  }
}

/** File kinds that can refer to other files, so a move may need to rewrite them. */
export function holdsReferences(path: string): boolean {
  return /\.(md|mdx|excalidraw|d2)$/i.test(path)
}

const isD2 = (path: string) => /\.d2$/i.test(path)

/**
 * Kinds of file the app edits (notes, drawings, diagrams and their JSON), at
 * paths references can name. Other files, such as ones an agent wrote, are
 * listed and open as text but are not renamed or moved here.
 */
export function canMove(path: string): boolean {
  return validateWorkspacePath(path.split("/").map(encodeURIComponent).join("/")) === path
}

/**
 * Plan a rename or move of one file, with its D2 companions, and the
 * reference rewrites it needs in every other file. `files` must include every
 * file in the project, with contents for those that `holdsReferences`.
 * Reference rewrites are computed on saved copies; a file with unsaved edits
 * or a sync conflict that the move touches becomes a blocker, not a change.
 */
export function planMove(files: readonly MoveSourceFile[], folders: readonly string[], request: MoveRequest): MovePlan {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const source = byPath.get(request.path)
  if (!source) throw new MoveRefusedError(`${request.path} is not in this project.`)
  if (!source.revision) throw new MoveRefusedError(`Save ${request.path} before moving or renaming it.`)
  if (!canMove(source.path)) throw new MoveRefusedError(`${source.path} is not a kind of file that can be renamed or moved here.`)

  const owner = isD2(source.path) ? null : diagramPartnerPaths(source.path).find((path) => isD2(path) && byPath.has(path))
  if (owner) {
    throw new MoveRefusedError(`${source.path} is generated from ${owner}. Move or rename ${owner} instead, and its generated files go with it.`)
  }

  let to: string
  if ("name" in request) {
    const destination = renameDestinationPath(source.path, request.name)
    if (!destination) throw new MoveRefusedError(`"${request.name}" is not a valid name for ${source.path}. Keep its extension.`)
    to = destination
  } else {
    if (request.folder !== "" && !folders.includes(request.folder)) throw new MoveRefusedError(`There is no folder ${request.folder}.`)
    to = request.folder === "" ? basenameForPath(source.path) : `${request.folder}/${basenameForPath(source.path)}`
  }
  if (to === source.path) throw new MoveRefusedError(`${source.path} is already there.`)

  const moves = [{ from: source.path, to }]
  if (isD2(source.path)) {
    const destinations = diagramPartnerPaths(to)
    diagramPartnerPaths(source.path).forEach((partner, index) => {
      if (byPath.has(partner)) moves.push({ from: partner, to: destinations[index] })
    })
  }

  const leaving = new Set(moves.map((move) => move.from))
  const staying = files.filter((file) => !leaving.has(file.path))
  for (const move of moves) {
    if (!isValidProjectPath(move.to)) throw new MoveRefusedError(`${move.to} is not a valid path.`)
    if (staying.some((file) => file.path === move.to)) throw new MoveRefusedError(`${move.to} already exists.`)
    if (folders.includes(move.to)) throw new MoveRefusedError(`${move.to} is a folder.`)
    const blocking = ancestorsOf(move.to).find((ancestor) => staying.some((file) => file.path === ancestor))
    if (blocking) throw new MoveRefusedError(`${blocking} is a file, so it cannot hold ${move.to}.`)
  }

  const blockers: MovePlan["blockers"] = []
  const block = (path: string, reason: string) => {
    if (!blockers.some((entry) => entry.path === path && entry.reason === reason)) blockers.push({ path, reason })
  }
  const unsettled = (file: MoveSourceFile, what: string) => {
    if (file.draft !== null) block(file.path, `It has unsaved edits. Save or discard them before ${what}.`)
    if (file.conflict) block(file.path, `It has a sync conflict. Resolve it before ${what}.`)
    if (!file.revision) block(file.path, `It has never been saved. Save it before ${what}.`)
  }
  for (const move of moves) unsettled(byPath.get(move.from)!, "moving it")

  const referring = (pick: (file: MoveSourceFile) => string | null): MoveReferenceFile[] =>
    files.flatMap((file) => {
      const content = holdsReferences(file.path) ? pick(file) : null
      return content === null ? [] : [{ path: file.path, content }]
    })
  const plan = planMoveReferences(referring((file) => file.saved), moves)
  for (const blocker of plan.blockers) block(blocker.path, blocker.reason)
  // Unsaved edits are checked too: saving them later must not bring an old path back.
  const drafted = planMoveReferences(referring((file) => file.draft), moves)
  for (const path of new Set([...plan.updates, ...drafted.updates].map((update) => update.path))) {
    const file = byPath.get(path)!
    if (!leaving.has(path)) unsettled(file, "its references are updated")
  }

  const rewritten = new Map(plan.updates.map((update) => [update.path, update.content]))
  const changes: LocalChange[] = moves.map((move) => ({
    kind: "move",
    from: move.from,
    to: move.to,
    expectedRevision: byPath.get(move.from)!.revision,
    ...(rewritten.has(move.from) ? { content: rewritten.get(move.from)! } : {}),
  }))
  for (const update of plan.updates) {
    if (leaving.has(update.path)) continue
    changes.push({ kind: "write", path: update.path, content: update.content, expectedRevision: byPath.get(update.path)!.revision })
  }

  return {
    moves,
    updates: plan.updates.map(({ path, references }) => ({ path, references })),
    blockers,
    changes,
  }
}
