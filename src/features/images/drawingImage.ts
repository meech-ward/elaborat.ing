import { inspectImage } from './format'
import { MAX_IMAGE_INTENT_BYTES } from './transport'
import { MAX_IMAGE_PIXELS, imageDataURL } from './types'

export const DRAWING_IMAGE_EDGE = 1600
export type DrawingImage = { dataURL: string; mimeType: string; width: number; height: number }

/** Drawing copies trade resolution for a bounded native scene, independently of project originals. */
export async function optimizeDrawingImage(blob: Blob, maxBytes: number, signal?: AbortSignal): Promise<DrawingImage> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('There is no room for another image in this drawing.')
  if (!blob.size || blob.size > MAX_IMAGE_INTENT_BYTES) throw new Error('Choose up to 20 MiB of images at a time.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  // A larger local input may be reduced before embedding. Stored project images
  // and every other caller retain inspectImage's original 5 MiB default.
  const header = inspectImage(bytes, blob.type, MAX_IMAGE_INTENT_BYTES)
  let bitmap: ImageBitmap | HTMLImageElement | undefined
  let vectorURL: string | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    if (header.mediaType === 'image/svg+xml') {
      const image = new Image()
      vectorURL = URL.createObjectURL(new Blob([bytes], { type: header.mediaType }))
      image.src = vectorURL
      await image.decode()
      bitmap = image
    } else {
      bitmap = await createImageBitmap(new Blob([bytes], { type: header.mediaType }), { imageOrientation: 'from-image' })
    }
    signal?.throwIfAborted()
    // SVG intrinsic dimensions can be absent; its checked viewBox is authoritative.
    const width = header.mediaType === 'image/svg+xml' ? header.width : bitmap.width
    const height = header.mediaType === 'image/svg+xml' ? header.height : bitmap.height
    if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) throw new Error('Choose an image with at most 8 million pixels for the drawing.')
    if (!header.animated && blob.size <= maxBytes && Math.max(width, height) <= DRAWING_IMAGE_EDGE) {
      return { dataURL: imageDataURL(bytes, header.mediaType), mimeType: header.mediaType, width, height }
    }
    canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This image could not be resized in this browser.')
    // Always scale from the decoded source, preserving alpha and the aspect ratio.
    let edge = Math.min(DRAWING_IMAGE_EDGE, Math.max(width, height))
    while (true) {
      const scale = Math.min(1, edge / Math.max(width, height))
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.82, 0.62]) {
        signal?.throwIfAborted()
        // Browsers without a WebP encoder return PNG; use its real media type.
        const raster = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/webp', quality))
        signal?.throwIfAborted()
        if (raster && raster.size > 0 && raster.size <= maxBytes && ['image/webp', 'image/png'].includes(raster.type)) {
          const rasterBytes = new Uint8Array(await raster.arrayBuffer())
          signal?.throwIfAborted()
          const mimeType = raster.type === 'image/webp' ? 'image/webp' : 'image/png'
          return { dataURL: imageDataURL(rasterBytes, mimeType), mimeType, width: canvas.width, height: canvas.height }
        }
      }
      if (edge === 1) throw new Error('This image could not be made small enough for the drawing.')
      edge = Math.max(1, Math.floor(edge * 0.75))
    }
  } finally {
    if (bitmap && 'close' in bitmap) bitmap.close()
    if (vectorURL) URL.revokeObjectURL(vectorURL)
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}
