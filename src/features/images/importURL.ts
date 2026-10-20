import { loadClient } from '@/lib/supabase/client'
import { ImageAssetSchema, imageExtension } from './types'
const retries = new Map<string, { id: string; started: number }>()

import { prepareImage } from './prepare'

/** Only the explicit Import button calls this; document URLs never trigger it. */
export async function importProjectImageURL(projectId: string, url: string,signal?:AbortSignal) {
  signal?.throwIfAborted()
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || url.length > 2048) throw new Error("Use a public HTTPS image URL without credentials or a custom port.");
  const client = await loadClient()
  signal?.throwIfAborted()
  const retryKey = `${projectId}:${url}`;
  const previous = retries.get(retryKey);
  const reused = previous && Date.now() - previous.started < 50 * 60 * 1000;
  const assetId = reused ? previous.id : crypto.randomUUID();
  if (retries.size >= 32 && !retries.has(retryKey)) retries.delete(retries.keys().next().value!);
  retries.set(retryKey, { id: assetId, started: reused ? previous.started : Date.now() });
  const response = await client.functions.invoke(`images?import=1&project_id=${encodeURIComponent(projectId)}`, {
    body: { url, asset_id: assetId },signal,
  })
  signal?.throwIfAborted()
  if (response.error) {
    let message = 'The image URL could not be imported. Try a direct public HTTPS image URL.'
    if ('context' in response.error && response.error.context instanceof Response) {
      const body: unknown = await response.error.context.json().catch(() => null)
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') message = body.error
    }
    throw new Error(message)
  }
  const asset = ImageAssetSchema.parse(response.data?.asset)
  if (asset.id !== assetId || !asset.object_key.startsWith(`${projectId}/`)) throw new Error("The imported image identity does not match this project.");
  const original = await client.storage.from('project-images').download(asset.object_key,{}, {signal})
  signal?.throwIfAborted()
  if (original.error || !original.data) throw new Error('The imported image could not be downloaded. Try again.')
  const prepared = await prepareImage(original.data, projectId, asset.id,signal)
  if (prepared.asset.sha256 !== asset.sha256 || prepared.asset.width !== asset.width || prepared.asset.height !== asset.height) throw new Error("The imported image does not match its saved bytes.");
  retries.delete(retryKey);
  let name = `image.${imageExtension(asset.media_type)}`
  try { name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) || name) } catch { /* use safe default */ }
  return { ...prepared, name }
}
