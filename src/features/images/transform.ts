import { MAX_IMAGE_PIXELS } from "./types"
import { prepareImage, type PreparedImage } from "./prepare"

export type ImageTransform = { x: number; y: number; cropWidth: number; cropHeight: number; width: number; height: number }

/** Validate source crop and output allocation before the browser creates a canvas. */
export function validateImageTransform(source: { width: number; height: number }, transform: ImageTransform): void {
  if (Object.values(transform).some((value) => !Number.isSafeInteger(value))) throw new Error("Image sizes and crop positions must be whole pixels.")
  if (transform.x < 0 || transform.y < 0 || transform.cropWidth < 1 || transform.cropHeight < 1 || transform.x + transform.cropWidth > source.width || transform.y + transform.cropHeight > source.height) throw new Error("Keep the crop inside the original image.")
  if (transform.width < 1 || transform.height < 1 || transform.width * transform.height > MAX_IMAGE_PIXELS || transform.width > 32_767 || transform.height > 32_767) throw new Error(`Choose a positive image size with at most ${MAX_IMAGE_PIXELS / 1_000_000} million pixels and 32,767 pixels on each side.`)
}

/** Explicit transforms create a new PNG asset and retain the unmodified original. */
export async function transformImage(image: PreparedImage, transform: ImageTransform, projectId: string, originalPath?: string): Promise<PreparedImage> {
  validateImageTransform(image.asset, transform)
  let bitmap: ImageBitmap | HTMLCanvasElement | undefined
  let vectorURL: string | null = null
  try {
    if (image.asset.media_type === "image/svg+xml") {
      const element = new Image()
      vectorURL = URL.createObjectURL(image.bytes)
      element.src = vectorURL
      try { await element.decode() } catch { throw new Error("This SVG could not be decoded for editing.") }
      // A viewBox-only SVG has a browser-default intrinsic size. Rasterize
      // its full extent before interpreting crop coordinates in source pixels.
      bitmap = document.createElement("canvas")
      bitmap.width = image.asset.width
      bitmap.height = image.asset.height
      const context = bitmap.getContext("2d")
      if (!context) throw new Error("Image editing is unavailable in this browser.")
      context.drawImage(element, 0, 0, bitmap.width, bitmap.height)
    } else bitmap = await createImageBitmap(image.bytes, { imageOrientation: "from-image" })
    const canvas = document.createElement("canvas")
    canvas.width = transform.width
    canvas.height = transform.height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Image editing is unavailable in this browser.")
    context.drawImage(bitmap, transform.x, transform.y, transform.cropWidth, transform.cropHeight, 0, 0, transform.width, transform.height)
    const bytes = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!bytes) throw new Error("The resized image could not be made. Choose a smaller size.")
    const name = `${image.name.replace(/\.[^.]+$/, "") || "image"}-edited.png`
    const derived = await prepareImage(new File([bytes], name, { type: "image/png" }), projectId)
    return { ...derived, original: image.original ?? image, ...(originalPath || image.originalPath ? { originalPath: originalPath ?? image.originalPath } : {}) }
  } finally { if (bitmap && "close" in bitmap) bitmap.close(); if (vectorURL) URL.revokeObjectURL(vectorURL) }
}
