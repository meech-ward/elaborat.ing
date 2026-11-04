import type { ProjectDatabase } from "./database"
import type { ImageAsset } from "./model"
import { RemoteError, type ProjectRemote } from "./remote"

export type ImageTransfer = { identity: string; promise: Promise<void>; signal?: AbortSignal }

/** Optional offline work loads after useful file metadata has been published. */
export async function cacheRemoteImages(
  db: ProjectDatabase,
  remote: ProjectRemote,
  partition: string,
  projectId: string,
  assets: ImageAsset[],
  changed: () => void,
  signal?: AbortSignal,
  transfers = new Map<string, ImageTransfer>(),
): Promise<void> {
  const queue = [...new Map(assets.map(asset => [asset.id, asset])).values()]
  let next = 0
  let failure: unknown
  const worker = async () => {
    while (next < queue.length) {
      signal?.throwIfAborted()
      const asset = queue[next++]
      try {
        await sharedTransfer(transfers, `${projectId}:${asset.id}`, JSON.stringify(Object.entries(asset).sort(([a], [b]) => a.localeCompare(b))), signal, async () => {
        const existing = await db.transaction(partition, "readonly", tx => tx.getAsset(projectId, asset.id))
        if (existing && (existing.asset.sha256 !== asset.sha256 || existing.asset.byte_length !== asset.byte_length || existing.asset.media_type !== asset.media_type || existing.asset.width !== asset.width || existing.asset.height !== asset.height)) {
          throw new RemoteError("invalid", "An immutable image changed its saved identity.")
        }
        if (existing?.asset.sha256 === asset.sha256 && existing.bytes.size === asset.byte_length && matchesPreview(existing.preview, asset)) return
        const [bytes, preview] = await Promise.all([
          existing?.asset.sha256 === asset.sha256 && existing.bytes.size === asset.byte_length ? existing.bytes : remote.downloadImage(projectId, asset, false, signal),
          remote.downloadImage(projectId, asset, true, signal),
        ])
        signal?.throwIfAborted()
        if (!matchesPreview(preview, asset)) throw new RemoteError("invalid", "A downloaded image preview does not match its saved size or type.")
        const digest = await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer())
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
        if (bytes.size !== asset.byte_length || sha256 !== asset.sha256 || bytes.type !== asset.media_type) throw new RemoteError("invalid", "A downloaded image does not match its saved digest or type.")
        await db.transaction(partition, "readwrite", async tx => {
          signal?.throwIfAborted()
          if (await tx.getProject(projectId)) await tx.putAsset({ partition, projectId, id: asset.id, asset, bytes, preview, uploaded: true })
        })
        changed()
        })
      } catch (error) { failure ??= error }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
  if (failure) throw failure
}

function matchesPreview(preview: Blob | undefined, asset: ImageAsset): preview is Blob {
  return Boolean(preview && preview.size === asset.preview_byte_length && preview.type === asset.preview_type)
}

/** A visible request joins a healthy transfer, while a canceled owner can be retried. */
async function sharedTransfer(transfers: Map<string, ImageTransfer>, key: string, identity: string, signal: AbortSignal | undefined, work: () => Promise<void>): Promise<void> {
  for (;;) {
    signal?.throwIfAborted()
    let transfer = transfers.get(key)
    if (transfer && transfer.identity !== identity) throw new RemoteError("invalid", "An immutable image changed its saved identity.")
    if (!transfer || transfer.signal?.aborted) {
      transfer = { identity, promise: work(), signal }
      transfers.set(key, transfer)
      const own = transfer
      void own.promise.finally(() => { if (transfers.get(key) === own) transfers.delete(key) }).catch(() => {})
    }
    try {
      await cancellableWait(transfer.promise, signal)
      return
    } catch (error) {
      signal?.throwIfAborted()
      if (!transfer.signal?.aborted) throw error
    }
  }
}

function cancellableWait(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason) }
    signal.addEventListener("abort", aborted, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}
