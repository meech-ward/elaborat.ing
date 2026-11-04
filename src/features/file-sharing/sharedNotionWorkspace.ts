import type {NotionWorkspace} from '@/features/exports/notionExport'
import {inspectImage} from '@/features/images/format'
import {decodeImageDataURL} from '@/features/images/transport'
import {IMAGE_PREVIEW_EDGE, MAX_IMAGE_PIXELS, MAX_IMAGE_PREVIEW_BYTES, isImagePath} from '@/features/images/types'
import type {WorkspaceFile} from '@/features/workbench/workspaceStore'
import {SharedBundle, type SharedImage} from './publicRemote'

/** A local, read-only export view of exactly one authorized response. No
 * account client, Storage path, network request or write operation exists. */
export function sharedNotionWorkspace(bundle: SharedBundle): NotionWorkspace {
  // Parsing also copies nested records, so a later refresh or caller mutation
  // cannot replace source or image strings while an export is being prepared.
  const snapshot = SharedBundle.parse(bundle)
  if (snapshot.complete === false || snapshot.fileErrors?.length || snapshot.imageErrors?.length)
    throw new Error('The shared document must finish loading before export.')
  const files = new Map(snapshot.files.map(file => [file.path, Object.freeze({...file})]))
  const images = new Map(snapshot.images.map(image => [image.path, Object.freeze({...image, preview: Object.freeze({...image.preview})})]))
  const revisions = new Map(snapshot.files.map(file => [file.path,
    JSON.stringify(['shared-export', snapshot.share.id, snapshot.share.revision, file.path, file.id, file.version])]))
  for (const [path, image] of images) {
    const file = files.get(path)
    if (!file || !isImagePath(path) || file.content !== '')
      throw new Error('A shared image is not an authorized image file.')
    if (image.width * image.height > MAX_IMAGE_PIXELS)
      throw new Error('The shared image exceeds the pixel limit.')
  }
  const blobs = new Map<string, Blob>()
  const unavailable = () => new Error('This file is not included in the shared document.')
  const imageFor = (path: string): SharedImage => {
    if (!files.has(path) || !isImagePath(path)) throw unavailable()
    const image = images.get(path)
    if (!image) throw new Error('This shared image is unavailable.')
    return image
  }
  const readImage = async (path: string, preview = false): Promise<Blob> => {
    const image = imageFor(path)
    const key = `${preview ? 'preview' : 'original'}\0${path}`
    const cached = blobs.get(key)
    if (cached) return cached
    const pixels = preview ? image.preview : image
    const {bytes, mediaType} = decodeImageDataURL(pixels.dataURL)
    const info = inspectImage(bytes, mediaType)
    const rotated = !preview && info.orientation >= 5 && info.orientation <= 8
    if ((rotated ? info.height : info.width) !== pixels.width || (rotated ? info.width : info.height) !== pixels.height)
      throw new Error('The shared image does not match its saved dimensions.')
    if (preview && (bytes.length > MAX_IMAGE_PREVIEW_BYTES || info.width > IMAGE_PREVIEW_EDGE || info.height > IMAGE_PREVIEW_EDGE ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)))
      throw new Error('The shared image preview exceeds its size or format limit.')
    const blob = new Blob([new Uint8Array(bytes)], {type: mediaType})
    blobs.set(key, blob)
    return blob
  }
  return Object.freeze({
    async read(path: string): Promise<WorkspaceFile> {
      const file = files.get(path)
      if (!file) throw unavailable()
      const image = isImagePath(path)
      const size = image ? (await readImage(path)).size : new TextEncoder().encode(file.content).byteLength
      return Object.freeze({path, content: file.content, savedContent: file.content,
        kind: image ? 'image' : 'text', revision: revisions.get(path)!, size,
        draft: false, unsynced: false, conflict: false,
        server: Object.freeze({id: file.id, version: file.version})})
    },
    readImage,
    async readImageRevision(path: string, revision: string | null, preview = false): Promise<Blob> {
      if (!revision || revisions.get(path) !== revision) throw new Error('The shared image revision does not match this export.')
      return readImage(path, preview)
    },
  })
}
