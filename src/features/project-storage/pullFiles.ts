import type { StorageTransaction } from "./database"
import { isDirty, type LocalFile } from "./model"
import type { RemoteFile, DeletedFile } from "./remote"

const isDraftOnly = (file: LocalFile) => file.base === null && file.content === null

/**
 * Apply the server's changed and deleted files. Only files without local
 * changes are touched. Returns the revision this device has now fully taken
 * in: `until`, or lower when something had to be left for a later pull.
 */
export async function applyRemoteFiles(
  tx: StorageTransaction,
  partition: string,
  projectId: string,
  changed: RemoteFile[],
  deleted: DeletedFile[],
  until: number,
): Promise<number> {
  let reached = until
  const hold = (version: number) => {
    reached = Math.min(reached, version - 1)
  }

  for (const gone of deleted) {
    const local = await tx.findFileByBaseId(projectId, gone.id)
    if (!local) continue
    if (isDirty(local) || local.conflict !== null) {
      hold(gone.version)
      continue
    }
    if (local.draft) await tx.putFile({ ...local, base: null, content: null, batch: null })
    else await tx.deleteFile(projectId, local.path)
  }

  // Plan every placement before writing, so a file that cannot be placed stays where it was.
  type Plan = { remote: RemoteFile; local: LocalFile | null; occupant: LocalFile | null }
  const plans: Plan[] = []
  for (const remote of changed) {
    const local = await tx.findFileByBaseId(projectId, remote.id)
    if (local?.base && local.base.version > remote.version) continue
    if (local && (isDirty(local) || local.conflict !== null)) {
      hold(remote.version)
      continue
    }
    if (local && local.base!.version === remote.version && local.path === remote.path) continue
    const found = await tx.getFile(projectId, remote.path)
    plans.push({ remote, local, occupant: found && found.localId !== local?.localId ? found : null })
  }
  const failed = new Set<Plan>()
  for (let settled = false; !settled; ) {
    settled = true
    const vacated = new Set(plans.filter((plan) => plan.local && !failed.has(plan)).map((plan) => plan.local!.path))
    const claimed = new Set<string>()
    for (const plan of plans) {
      if (failed.has(plan)) continue
      const { occupant, local } = plan
      const blocked =
        claimed.has(plan.remote.path) ||
        (occupant !== null && !vacated.has(occupant.path) && !(isDraftOnly(occupant) && !local?.draft))
      if (blocked) {
        failed.add(plan)
        settled = false
      } else {
        claimed.add(plan.remote.path)
      }
    }
  }

  for (const plan of plans) if (failed.has(plan)) hold(plan.remote.version)
  const placing = plans.filter((plan) => !failed.has(plan))
  for (const { local } of placing) if (local) await tx.deleteFile(projectId, local.path)
  for (const { remote, local } of placing) {
    const occupant = await tx.getFile(projectId, remote.path)
    // Only an unsaved draft can be here now; keep it on top of the server's file.
    const draft = occupant?.draft ?? local?.draft ?? null
    await tx.putFile({
      partition,
      projectId,
      localId: local?.localId ?? occupant?.localId ?? crypto.randomUUID(),
      path: remote.path,
      base: { id: remote.id, path: remote.path, version: remote.version, content: remote.content, ...(remote.kind === "image" ? { kind: "image" as const, asset_id: remote.asset_id, asset: remote.asset } : {}) },
      content: remote.content,
      ...(remote.kind === "image" ? { kind: "image" as const, asset_id: remote.asset_id, asset: remote.asset } : {}),
      batch: null,
      draft: draft?.content === remote.content ? null : draft,
      conflict: null,
    })
  }
  return reached
}

/** Follow the server's explicit folders, except where this device has a folder change still to send. */
export async function applyRemoteFolders(tx: StorageTransaction, partition: string, projectId: string, remote: string[]) {
  const server = new Set(remote)
  const local = await tx.listFolders(projectId)
  for (const folder of local) {
    const onServer = server.has(folder.path)
    const next = folder.base === folder.local ? { ...folder, base: onServer, local: onServer } : { ...folder, base: onServer }
    if (!next.base && !next.local) await tx.deleteFolder(projectId, folder.path)
    else await tx.putFolder(next)
  }
  const known = new Set(local.map((folder) => folder.path))
  for (const path of server) if (!known.has(path)) await tx.putFolder({ partition, projectId, path, base: true, local: true, batch: null })
}
