import type { ProjectDatabase } from "./database"
import { assetToken, type ImageAsset, type LocalImageAsset, type PendingSave } from "./model"
import { RemoteError, type ProjectRemote } from "./remote"

/** Upload recovery is needed only by an explicit save containing image bytes. */
export class ImageUploads {
  constructor(private readonly db: ProjectDatabase, private readonly remote: ProjectRemote, private readonly partition: string) {}

  /** Retry committed saves unchanged; only proven expired staging gets a new identity. */
  async uploadPendingImages(projectId: string, pending: PendingSave): Promise<PendingSave> {
    for (let index = 0; index < pending.changes.length; index++) {
      const change = pending.changes[index]
      if (change.op !== "asset" && !(change.op === "move" && change.asset_id)) continue
      let local = await this.db.transaction(this.partition, "readonly", (tx) => tx.getAsset(projectId, change.asset_id!))
      if (!local) throw new RemoteError("invalid", "The image bytes are missing from this device. Your note has not been saved to the server.")
      let asset: ImageAsset | undefined
      if (local.uploaded || local.uploadAttempted) {
        // The RPC takes the same project lock as save_files: a missing answer
        // cannot race a previous save that is still committing this asset.
        const status = await this.remote.imageUploadStatus(projectId, local.id)
        if (status.status === "available") asset = status.asset
        else if (status.status === "expired" || status.status === "missing") {
          const rotated = await this.rotatePendingImage(projectId, pending, local)
          pending = rotated.pending
          local = rotated.local
        }
      }
      if (!asset) {
        // Keep the attempt across a crash or lost response, including before
        // the upload finished and before a preview could be downloaded.
        local = { ...local, uploadAttempted: true }
        await this.db.transaction(this.partition, "readwrite", async (tx) => {
          if (await tx.getProject(projectId)) await tx.putAsset(local!)
        })
        asset = await this.remote.uploadImage(projectId, local.asset, local.bytes)
      }
      if (asset.id !== local.id || asset.sha256 !== local.asset.sha256 || asset.byte_length !== local.bytes.size || asset.media_type !== local.asset.media_type || asset.width !== local.asset.width || asset.height !== local.asset.height) throw new RemoteError("invalid", "The uploaded image does not match the local image.")
      // New uploads use trusted preview bytes even when the browser happened
      // to produce the same codec and length.
      const verifiedPreview = local.uploaded && matchesImagePreview(local.preview, asset) ? local.preview! : await this.downloadImagePreview(projectId, asset)
      await this.db.transaction(this.partition, "readwrite", async (tx) => {
        if (!await tx.getProject(projectId)) return
        await tx.putAsset({ ...local!, asset, preview: verifiedPreview, uploaded: true })
        for (const file of await tx.listFiles(projectId)) {
          if (file.asset?.id !== asset.id && file.draft?.asset?.id !== asset.id) continue
          await tx.putFile({ ...file, ...(file.asset?.id === asset.id ? { asset } : {}), ...(file.draft?.asset?.id === asset.id ? { draft: { ...file.draft, asset } } : {}) })
        }
      })
    }
    return pending
  }

  private async rotatePendingImage(projectId: string, pending: PendingSave, previous: LocalImageAsset): Promise<{ pending: PendingSave; local: LocalImageAsset }> {
    const id = crypto.randomUUID()
    const asset: ImageAsset = { ...previous.asset, id, object_key: `${projectId}/${id}/original`, preview_key: `${projectId}/${id}/preview` }
    const local: LocalImageAsset = { ...previous, id, asset, uploaded: false, uploadAttempted: false }
    const next: PendingSave = {
      ...pending,
      mutationId: crypto.randomUUID(),
      changes: pending.changes.map(change => (change.op === "asset" || change.op === "move") && change.asset_id === previous.id ? { ...change, asset_id: id } : change),
      files: pending.files.map(file => file.asset?.id === previous.id ? { ...file, asset_id: id, asset } : file),
    }
    await this.db.transaction(this.partition, "readwrite", async tx => {
      const project = await tx.getProject(projectId)
      if (project?.pending?.mutationId !== pending.mutationId) throw new RemoteError("network", "The pending save changed. Sync again to continue.")
      await tx.putAsset(local)
      for (const file of await tx.listFiles(projectId)) {
        if (file.asset?.id !== previous.id && file.draft?.asset?.id !== previous.id) continue
        const draft = file.draft ? {
          ...file.draft,
          // A different replacement draft still rests on these same saved
          // bytes. Rekeying their staging identity must not make it stale.
          ...(file.asset?.id === previous.id && file.draft.token === assetToken(previous.asset) ? { token: assetToken(asset) } : {}),
          ...(file.draft.asset?.id === previous.id ? { asset } : {}),
        } : null
        await tx.putFile({ ...file, ...(file.asset?.id === previous.id ? { asset_id: id, asset } : {}), draft })
      }
      await tx.putProject({ ...project, pending: next })
    })
    return { pending: next, local }
  }

  private async downloadImagePreview(projectId: string, asset: ImageAsset): Promise<Blob> {
    const preview = await this.remote.downloadImage(projectId, asset, true)
    if (!matchesImagePreview(preview, asset)) throw new RemoteError("invalid", "A downloaded image preview does not match its saved size or type.")
    return preview
  }

}

/** Browser-made previews may differ from the immutable preview verified by the server. */
function matchesImagePreview(preview: Blob | undefined, asset: ImageAsset): preview is Blob {
  return Boolean(preview && preview.size === asset.preview_byte_length && preview.type === asset.preview_type)
}
