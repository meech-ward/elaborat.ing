import {documentImage} from '@/features/images/documentImage'
import {MAX_IMAGE_BYTES} from '@/features/images/types'

/** Captured SVG is untrusted. The shared image inspector bounds its XML,
 * geometry, text and local references before the browser decodes anything.
 * Scripts, external resources and foreignObject are refused there.
 */
export async function notionVector(svg: string, raster: (dataURL: string) => Promise<string>, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const bytes = new TextEncoder().encode(svg)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The component graphic exceeds 5 MiB.')
  const pixels = await documentImage(new Blob([bytes], {type: 'image/svg+xml'}), signal)
  signal?.throwIfAborted()
  return raster(pixels.dataURL)
}
