import type { DrawingScene } from '../drawings/types'
import type { WorkspaceStore } from '../workbench/workspaceStore'
import { isValidProjectPath, MAX_FILE_BYTES } from '../project-storage/model'
import { inspectImage } from '../images/format'
import { decodeImageDataURL } from '../images/transport'
import { imageDigest, imageExtension, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../images/types'

export type NotionAsset = {path: string; bytes: Uint8Array}
export type NotionAssets = {
  files: NotionAsset[];
  image(path: string): Promise<string>;
  drawing(path: string): Promise<string>;
  diagram(path: string): Promise<string>;
  raster(dataURL: string): Promise<string>;
}

const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_ASSETS = 256
const encoder = new TextEncoder()

/** A frozen project's portable image files. Only validated bytes enter the ZIP. */
export function createNotionAssets(client: Pick<WorkspaceStore, 'read' | 'readImage'>, signal?: AbortSignal): NotionAssets {
  const files: NotionAsset[] = []
  const byDigest = new Map<string, string>()
  const bySource = new Map<string, Promise<string>>()
  let total = 0
  // Native renderers and SVG/animation decoders can retain large canvases.
  // Serialize work even when the converter asks for several assets at once.
  let previous: Promise<unknown> = Promise.resolve()
  const enqueue = (work: () => Promise<string>) => {
    const result = previous.then(() => {signal?.throwIfAborted(); return work()})
    previous = result.catch(() => {})
    return result
  }
  const once = (identity: string, work: () => Promise<string>) => {
    const existing = bySource.get(identity)
    if (existing) return existing
    const result = enqueue(work)
    bySource.set(identity, result)
    void result.catch(() => {if (bySource.get(identity) === result) bySource.delete(identity)})
    return result
  }
  const pathFor = (path: string) => {
    signal?.throwIfAborted()
    if (!isValidProjectPath(path)) throw new Error('Choose a file inside this project.')
    return path
  }
  const add = async (bytes: Uint8Array, claimedType?: string) => {
    signal?.throwIfAborted()
    const image = inspectImage(bytes, claimedType)
    if (image.mediaType === 'image/svg+xml') throw new Error('Exported image assets must be raster images.')
    const digest = await imageDigest(bytes)
    signal?.throwIfAborted()
    const existing = byDigest.get(digest)
    if (existing) return existing
    if (files.length >= MAX_ASSETS) throw new Error('This export exceeds 256 image assets.')
    if (total + bytes.length > MAX_ASSET_BYTES) throw new Error('This export exceeds 64 MiB of image assets.')
    const path = `assets/${digest}.${imageExtension(image.mediaType)}`
    files.push({path, bytes: new Uint8Array(bytes)})
    byDigest.set(digest, path)
    total += bytes.length
    return path
  }
  const read = async (path: string) => {
    pathFor(path)
    const file = await client.read(path)
    signal?.throwIfAborted()
    if (file.kind !== 'image' && encoder.encode(file.content).length > MAX_FILE_BYTES)
      throw new Error(`The source file ${path} exceeds 2 MiB.`)
    return file
  }
  const blobBytes = async (blob: Blob) => {
    signal?.throwIfAborted()
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('Exported images must be 5 MiB or smaller.')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal?.throwIfAborted()
    return bytes
  }
  const nativePng = async (scene: DrawingScene) => {
    if (!scene.elements.some(element => !element.isDeleted)) throw new Error('An empty drawing has no image to export.')
    let nativePixels = 0
    // Excalidraw decodes its file table together. Check the entire table
    // before SVG rasterization or native decoding can allocate any pixels.
    const inputImages = Object.entries(scene.files ?? {}).map(([id, file]) => {
      signal?.throwIfAborted()
      if (!file || typeof file.dataURL !== 'string' || typeof file.mimeType !== 'string')
        throw new Error('The drawing contains an invalid image.')
      const {bytes, mediaType} = decodeImageDataURL(file.dataURL, file.mimeType)
      const image = inspectImage(bytes, mediaType)
      nativePixels += image.width * image.height
      if (nativePixels > 24_000_000) throw new Error('The drawing exceeds 24 million embedded image pixels.')
      return {id, file, bytes, mediaType}
    })
    const {documentImage} = await import('../images/documentImage')
    const checkedFiles: NonNullable<DrawingScene['files']> = Object.create(null)
    for (const {id, file, bytes, mediaType} of inputImages) {
      const pixels = await documentImage(new Blob([new Uint8Array(bytes)], {type: mediaType}), signal)
      const raster = decodeImageDataURL(pixels.dataURL)
      checkedFiles[id] = {...file, dataURL: pixels.dataURL, mimeType: raster.mediaType}
    }
    signal?.throwIfAborted()
    const [{configureExcalidrawAssets}, {exportDrawingPng}] = await Promise.all([
      import('../drawings/assets'), import('../drawings/export'),
    ])
    configureExcalidrawAssets()
    const blob = await exportDrawingPng({...scene, files: checkedFiles}, {scale: 2, maxPixels: MAX_IMAGE_PIXELS})
    signal?.throwIfAborted()
    return add(await blobBytes(blob), 'image/png')
  }
  return {
    files,
    async image(path) {
      pathFor(path)
      return once(`image\0${path}`, async () => {
        const file = await read(path)
        if (file.kind !== 'image' || !client.readImage) throw new Error(`The image ${path} is unavailable.`)
        const blob = await client.readImage(path)
        const bytes = await blobBytes(blob)
        const info = inspectImage(bytes, (file.asset?.media_type ?? blob.type) || undefined)
        if (info.mediaType !== 'image/svg+xml') return add(bytes, info.mediaType)
        const {documentImage} = await import('../images/documentImage')
        const pixels = await documentImage(new Blob([new Uint8Array(bytes)], {type: info.mediaType}), signal)
        const raster = decodeImageDataURL(pixels.dataURL)
        if (raster.mediaType !== 'image/png') throw new Error('This SVG exceeds the 5 MiB PNG export limit.')
        return add(raster.bytes, 'image/png')
      })
    },
    async drawing(path) {
      pathFor(path)
      return once(`drawing\0${path}`, async () => {
        if (!/\.excalidraw(?:\.md)?$/i.test(path)) throw new Error('Choose an Excalidraw drawing.')
        const file = await read(path)
        const {parseDrawingFile} = await import('../drawings/parse')
        return nativePng(parseDrawingFile(file.content, path).scene)
      })
    },
    async diagram(path) {
      pathFor(path)
      return once(`diagram\0${path}`, async () => {
        if (!/\.d2$/i.test(path)) throw new Error('Choose a D2 diagram.')
        const source = (await read(path)).content
        const [{nativePathFor, projectDiagramArtifact, readDiagramCompanion}, {sidecarPathFor}] = await Promise.all([
          import('../workbench/diagramArtifact'), import('../structured/structuredClient'),
        ])
        const nativePath = nativePathFor(path)
        const frozen = {read}
        const [native, sidecar] = await Promise.all([
          readDiagramCompanion(frozen, nativePath), readDiagramCompanion(frozen, sidecarPathFor(path)),
        ])
        const result = await projectDiagramArtifact({source, nativePath, nativeContent: native?.content ?? null,
          sidecarContent: sidecar?.content ?? null, compile: async () => {
            signal?.throwIfAborted()
            const {compileD2Diagram} = await import('../structured/compiler')
            const compiled = await compileD2Diagram(source)
            signal?.throwIfAborted()
            return compiled.ok ? {diagram: compiled.diagram, error: null} : {diagram: null, error: compiled.error}
          }})
        signal?.throwIfAborted()
        if (!result.ok && !result.persistedScene) throw new Error(result.diagnostics[0]?.message ?? 'The diagram could not be exported.')
        return nativePng(result.scene)
      })
    },
    async raster(dataURL) {
      signal?.throwIfAborted()
      return enqueue(async () => {
        const {bytes, mediaType} = decodeImageDataURL(dataURL)
        if (mediaType === 'image/svg+xml') throw new Error('Custom component snapshots must be raster images.')
        return add(bytes, mediaType)
      })
    },
  }
}
