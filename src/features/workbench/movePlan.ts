import type { LocalChange } from "@/features/project-storage/fileStore"
import { isValidProjectPath, MAX_ENTRIES } from "@/features/project-storage/model"
import { basenameForPath, diagramPartnerPaths, renameDestinationPath } from "@/features/workspace"
import { planMoveReferences, type MoveReferenceFile } from "@/features/workspace/moveRefs"
import { canMove, holdsReferences } from "./moveRules"
import { ancestorsOf, isCanonicalDirectoryPath, joinFolder, parentDirOf } from "./folderTree"

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

/** Move a folder into another folder ("" is the project's top level), or rename it where it is. */
export type FolderMoveRequest = { folder: string; into: string } | { folder: string; name: string }

export type MoveReference = { from: string; to: string; line: number }

export type MovePlan = {
  moves: Array<{ from: string; to: string }>
  /** Files whose references change. A moved file is listed under its old path. */
  updates: Array<{ path: string; references: MoveReference[] }>
  /** Reasons the move cannot go ahead yet. The changes are only safe to save when this is empty. */
  blockers: Array<{ path: string; reason: string }>
  /** The moves and rewritten files, as one save on this device. */
  changes: LocalChange[]
  /** Set for a folder move: the folder, and where it goes with everything in it. */
  folder?: { from: string; to: string }
}

/** The request itself cannot work (a missing file, a bad name, a taken destination). */
export class MoveRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MoveRefusedError"
  }
}

const isD2 = (path: string) => /\.d2$/i.test(path)

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

  return planMoves(files, moves, "moving it")
}

/**
 * Plan a rename or move of a folder with everything in it, as one save:
 * every file under it moves (a D2 diagram with its generated files, since
 * they share its folder), references to those files are rewritten in the
 * moved files and in files that point into the folder, and the explicit
 * folders under it (empty ones included) are made at the new place and
 * removed at the old. `folders` lists every folder, and `explicit` the ones
 * stored as folders rather than implied by the files in them. A file the
 * app does not move, or one that is not settled, becomes a blocker.
 */
export function planFolderMove(
  files: readonly MoveSourceFile[],
  folders: readonly string[],
  explicit: readonly string[],
  request: FolderMoveRequest,
): MovePlan {
  const from = request.folder
  if (!folders.includes(from)) throw new MoveRefusedError(`There is no folder ${from}.`)
  let to: string
  if ("name" in request) {
    to = joinFolder(parentDirOf(from), request.name)
    if (request.name.includes("/") || !isCanonicalDirectoryPath(to)) {
      throw new MoveRefusedError(`"${request.name}" is not a valid folder name. Use one name without separators, leading dots, or control characters.`)
    }
  } else {
    if (request.into !== "" && !folders.includes(request.into)) throw new MoveRefusedError(`There is no folder ${request.into}.`)
    if (request.into === from || request.into.startsWith(`${from}/`)) {
      throw new MoveRefusedError(`${from} cannot move into itself or one of its own folders.`)
    }
    to = joinFolder(request.into, basenameForPath(from))
  }
  if (to === from) throw new MoveRefusedError(`${from} is already there.`)
  if (folders.includes(to) || files.some((file) => file.path === to)) throw new MoveRefusedError(`${to} already exists.`)

  const under = (path: string) => path.startsWith(`${from}/`)
  const destination = (path: string) => `${to}${path.slice(from.length)}`
  const inside = files.filter((file) => under(file.path))
  const moves = inside.filter((file) => canMove(file.path)).map((file) => ({ from: file.path, to: destination(file.path) }))
  for (const move of moves) if (!isValidProjectPath(move.to)) throw new MoveRefusedError(`${move.to} is not a valid path.`)

  const plan = planMoves(files, moves, "moving its folder")
  for (const file of inside) {
    if (!canMove(file.path)) {
      plan.blockers.push({ path: file.path, reason: "It is a kind of file that cannot be renamed or moved here, so its folder cannot move either." })
    }
  }
  // Explicit folders keep being explicit: made at the new place (parents first) and removed at the old (children first).
  const stored = explicit.filter((path) => path === from || under(path)).sort()
  plan.changes.push(...stored.map((path): LocalChange => ({ kind: "mkdir", path: destination(path) })))
  plan.changes.push(...[...stored].reverse().map((path): LocalChange => ({ kind: "rmdir", path })))
  if (plan.changes.length > MAX_ENTRIES) {
    throw new MoveRefusedError(
      `Moving ${from} takes ${plan.changes.length} changes, more than the ${MAX_ENTRIES} one save can hold. Move some of what is in it first.`,
    )
  }
  return { ...plan, folder: { from, to } }
}

/**
 * The blockers, reference rewrites and changes for a set of file moves:
 * every moved file must be settled (saved, no draft, no conflict), and so
 * must every file whose references change. `what` names the action in the
 * moved files' blocker messages.
 */
function planMoves(files: readonly MoveSourceFile[], moves: Array<{ from: string; to: string }>, what: string): MovePlan {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const leaving = new Set(moves.map((move) => move.from))
  const blockers: MovePlan["blockers"] = []
  const block = (path: string, reason: string) => {
    if (!blockers.some((entry) => entry.path === path && entry.reason === reason)) blockers.push({ path, reason })
  }
  const unsettled = (file: MoveSourceFile, action: string) => {
    if (file.draft !== null) block(file.path, `It has unsaved edits. Save or discard them before ${action}.`)
    if (file.conflict) block(file.path, `It has a sync conflict. Resolve it before ${action}.`)
    if (!file.revision) block(file.path, `It has never been saved. Save it before ${action}.`)
  }
  for (const move of moves) unsettled(byPath.get(move.from)!, what)

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
