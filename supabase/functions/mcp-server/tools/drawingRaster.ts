import { parseDrawingScene } from '../../_shared/drawing.ts'
import { imageDataURL } from '../../../../src/features/images/types.ts'
import type { RasterImage } from './drawingSvg.ts'
/** Native scenes are untrusted text, unlike immutable server-validated project previews. */
export async function drawingRasters(
  content: string,
): Promise<Record<string, RasterImage>> {
  let scene: ReturnType<typeof parseDrawingScene>
  try {
    scene = parseDrawingScene(content)
  } catch {
    return {}
  }
  const wanted = [
    ...new Set(
      scene.elements.filter((e) =>
        e.type === 'image' && typeof e.fileId === 'string'
      ).map((e) => e.fileId as string),
    ),
  ].slice(0, 8)
  const result: Record<string, RasterImage> = Object.create(null)
  let inputBytes = 0, outputChars = 0
  for (const id of wanted) {
    const file = scene.files[id]
    if (!file || typeof file !== 'object') continue
    const dataURL = (file as Record<string, unknown>).dataURL
    if (typeof dataURL !== 'string' || dataURL.length > 2_800_000) continue
    const match =
      /^data:(image\/(?:png|jpeg|webp|svg\+xml|gif));base64,([A-Za-z0-9+/]+=*)$/
        .exec(dataURL)
    if (!match) continue
    try {
      const text = atob(match[2])
      inputBytes += text.length
      if (inputBytes > 2 * 1024 * 1024) break
      const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0))
      const { validateImage } = await import('../../_shared/images.ts')
      const validated = await validateImage(bytes, match[1])
      const preview = imageDataURL(validated.thumbnail, validated.thumbnailType)
      outputChars += preview.length
      if (outputChars > 80_000) break
      result[id] = {
        dataURL: preview,
        width: validated.width,
        height: validated.height,
      }
    } catch {
      /* Keep unsupported legacy bytes in the saved scene and show their placeholder. */
    }
  }
  return result
}
