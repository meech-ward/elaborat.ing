import type { BinaryFileData, DrawingScene } from '../features/drawings/types'
import { inspectImage } from '../features/images/format'
import { documentImage } from '../features/images/documentImage'
import { decodeImageDataURL } from '../features/images/transport'
import { MAX_PREVIEW_FILE_BYTES } from './protocol'
import { PreviewFailure } from './scene'

export const MAX_PREVIEW_IMAGE_PIXELS = 24_000_000
export const MAX_PREVIEW_IMAGES = 32

async function verifyRasterPixels(blob: Blob, width: number, height: number): Promise<void> {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('The decoded dimensions do not match the inspected image.')
  } catch (error) {
    throw new PreviewFailure('invalid_input', `A drawing image could not be decoded: ${error instanceof Error ? error.message : 'invalid pixels'}`)
  } finally { bitmap?.close() }
}

/** Inspect all referenced images before allowing any browser pixel decoder. */
export function inspectSceneImages(scene: DrawingScene) {
  const ids = [...new Set(scene.elements.filter(element => element.isDeleted !== true && element.type === 'image').map(element => element.fileId as string))]
  if (ids.length > MAX_PREVIEW_IMAGES) throw new PreviewFailure('limit', 'The drawing exceeds 32 distinct embedded images.')
  let pixels = 0, inputBytes = 0
  return ids.map((id, index) => {
    const file = scene.files?.[id]
    if (!file || typeof file.dataURL !== 'string' || typeof file.mimeType !== 'string') throw new PreviewFailure('invalid_input', 'A referenced drawing image is missing its saved bytes.')
    let decoded: ReturnType<typeof decodeImageDataURL>, header: ReturnType<typeof inspectImage>
    try {
      decoded = decodeImageDataURL(file.dataURL, file.mimeType)
      inputBytes += decoded.bytes.length
      if (inputBytes > MAX_PREVIEW_FILE_BYTES) throw new PreviewFailure('limit', 'The drawing exceeds 2 MiB of embedded image bytes.')
      header = inspectImage(decoded.bytes, decoded.mediaType)
    } catch (error) {
      if (error instanceof PreviewFailure) throw error
      throw new PreviewFailure('invalid_input', `A drawing image is unsafe or unreadable: ${error instanceof Error ? error.message : 'invalid image'}`)
    }
    pixels += header.width * header.height
    if (pixels > MAX_PREVIEW_IMAGE_PIXELS) throw new PreviewFailure('limit', 'The drawing exceeds 24 million embedded image pixels.')
    return { originalId: id, safeId: `preview-image-${index}`, file, decoded, header }
  })
}

/** Native SVG receives static validated image pixels, never network URLs. */
export async function prepareSceneImages(scene: DrawingScene, verifyPixels = verifyRasterPixels): Promise<{ scene: DrawingScene; flattened: boolean }> {
  // Complete the header checks for the entire table before the first decode.
  const inspected = inspectSceneImages(scene)
  const files: Record<string, BinaryFileData> = Object.create(null)
  const ids = new Map<string, string>()
  let flattened = false, outputBytes = 0
  for (const { originalId, safeId, file, decoded, header } of inspected) {
    const image = await documentImage(new Blob([new Uint8Array(decoded.bytes)], { type: decoded.mediaType }))
    const raster = decodeImageDataURL(image.dataURL)
    // documentImage intentionally passes static raster originals through. A
    // complete pixel decode here catches corrupt streams before SVG export
    // can quietly omit a broken embedded image.
    await verifyPixels(new Blob([new Uint8Array(raster.bytes)], { type: raster.mediaType }), image.width, image.height)
    outputBytes += raster.bytes.length
    if (outputBytes > 16 * 1024 * 1024) throw new PreviewFailure('limit', 'The validated drawing images exceed the renderer byte budget.')
    files[safeId] = { ...file, id: safeId, dataURL: image.dataURL, mimeType: raster.mediaType }
    ids.set(originalId, safeId)
    flattened ||= header.animated || header.mediaType === 'image/svg+xml' || header.mediaType === 'image/gif'
  }
  return {
    scene: { ...scene, files, elements: scene.elements.filter(element => element.isDeleted !== true).map(element => element.type === 'image' ? { ...element, fileId: ids.get(element.fileId as string)! } : element) },
    flattened,
  }
}
