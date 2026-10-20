import { loadClient } from '@/lib/supabase/client'
import { ImageAssetSchema, imageDigest, type ImageAsset } from './types'

/** Authenticated immutable history reads, with no URLs exposed to document code. */
export async function downloadImageAsset(projectId: string, metadata: ImageAsset, preview = false): Promise<Blob> {
  const asset = ImageAssetSchema.parse(metadata)
  if (!asset.object_key.startsWith(`${projectId}/`)) throw new Error('This image belongs to another project.')
  const client = await loadClient()
  const response = await client.storage.from('project-images').download(preview ? asset.preview_key : asset.object_key)
  if (response.error || !response.data) throw new Error('The image version could not be downloaded. Check your connection.')
  if (response.data.size !== (preview ? asset.preview_byte_length : asset.byte_length)) throw new Error('The downloaded image is incomplete.')
  if (!preview && await imageDigest(new Uint8Array(await response.data.arrayBuffer())) !== asset.sha256) throw new Error('The downloaded image does not match its saved version.')
  return response.data
}
