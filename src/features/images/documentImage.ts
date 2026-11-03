import { inspectImage } from './format'
import { MAX_IMAGE_BYTES, imageDataURL } from './types'
import type { ImagePreview } from './transport'

/** Reading uses original detail, not the small thumbnail stored for lists and MCP.
 * Animated and vector originals become a static raster in the trusted parent.
 * The isolated document still receives only bounded raster data URLs.
 */
export async function documentImage(blob: Blob, signal?: AbortSignal): Promise<ImagePreview> {
  signal?.throwIfAborted()
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('The image exceeds the document image limit.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  const header = inspectImage(bytes, blob.type)
  if (!header.animated && ['image/png', 'image/jpeg', 'image/webp'].includes(header.mediaType)) {
    const rotated = header.orientation >= 5 && header.orientation <= 8
    return {dataURL: imageDataURL(bytes, header.mediaType),
      width: rotated ? header.height : header.width, height: rotated ? header.width : header.height}
  }

  let bitmap: ImageBitmap | HTMLImageElement | undefined
  let vectorURL: string | undefined
  try {
    if (header.mediaType === 'image/svg+xml') {
      const image = new Image()
      vectorURL = URL.createObjectURL(new Blob([bytes], {type: header.mediaType}))
      image.src = vectorURL
      await image.decode()
      bitmap = image
    } else bitmap = await createImageBitmap(new Blob([bytes], {type: header.mediaType}), {imageOrientation: 'from-image'})
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    canvas.width = header.width
    canvas.height = header.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This image could not be rendered.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // Keep text, lines and transparency lossless whenever the bounded PNG fits.
    // Dense animation frames can need WebP compression to stay within the same
    // 5 MiB transport contract, without reducing their pixel dimensions.
    let raster = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    signal?.throwIfAborted()
    for (const quality of [0.95, 0.9, 0.8, 0.7]) {
      if (raster && raster.size <= MAX_IMAGE_BYTES) break
      raster = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality))
      signal?.throwIfAborted()
    }
    if (!raster || raster.size > MAX_IMAGE_BYTES) throw new Error('This image could not be rendered within the document image limit.')
    const rasterBytes = new Uint8Array(await raster.arrayBuffer())
    signal?.throwIfAborted()
    return {dataURL: imageDataURL(rasterBytes, raster.type === 'image/webp' ? 'image/webp' : 'image/png'),
      width: canvas.width, height: canvas.height}
  } finally {
    if (bitmap && 'close' in bitmap) bitmap.close()
    if (vectorURL) URL.revokeObjectURL(vectorURL)
  }
}
