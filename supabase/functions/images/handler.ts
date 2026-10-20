export type ValidatedImage = {
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/svg+xml'
    | 'image/gif'
  width: number
  height: number
  sha256: string
  byteLength: number
  thumbnail: Uint8Array
  thumbnailType: 'image/png' | 'image/jpeg' | 'image/webp'
}
export type ImageAsset = {
  id: string
  media_type: ValidatedImage['mediaType']
  byte_length: number
  width: number
  height: number
  sha256: string
  object_key: string
  preview_key: string
  preview_type: ValidatedImage['thumbnailType']
  preview_byte_length: number
}
type DbError = { code?: string; message: string }
export type Answer<T> = { data: T | null; error: DbError | null }
export type ImageIdentity = {
  projectId: string
  assetId: string
  userId: string
}
export type ImageDeps = {
  validate: (bytes: Uint8Array, claimedType?: string) => Promise<ValidatedImage>
  reserve: (
    identity: ImageIdentity,
    image: ValidatedImage,
  ) => Promise<Answer<unknown>>
  complete: (
    identity: ImageIdentity,
    image: ValidatedImage,
  ) => Promise<Answer<unknown>>
  upload: (
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ) => Promise<{ error: { message: string } | null }>
  download: (key: string) => Promise<Uint8Array | null>
}
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })
export function databaseRefusal(error: DbError): Response {
  switch (error.code) {
    case '42501':
      return refuse(403, error.message)
    case '22023':
      return refuse(400, error.message)
    case 'PT410':
      return refuse(410, error.message)
    case '55000':
      return refuse(409, error.message)
    case '54000':
      return refuse(413, error.message)
    case 'PT429':
      return refuse(429, error.message)
    default:
      console.error('images: database refused upload', error.code)
      return refuse(
        502,
        'The image could not be saved. Your draft is still on this device. Try again.',
      )
  }
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
async function uploadImmutable(
  key: string,
  bytes: Uint8Array,
  mediaType: string,
  deps: ImageDeps,
): Promise<void> {
  const { error } = await deps.upload(key, bytes, mediaType)
  if (!error) return
  // A lost success response is indistinguishable from an interrupted upload.
  // Read the immutable key and accept only exactly the original bytes.
  const existing = await deps.download(key)
  if (existing && sameBytes(existing, bytes)) return
  throw new Error(
    'The image upload did not finish. Your draft is still on this device. Try again.',
  )
}
/** Used by both raw uploads and explicit, authorized URL imports. */
export async function storeImage(
  bytes: Uint8Array,
  claimedType: string | undefined,
  identity: ImageIdentity,
  deps: ImageDeps,
): Promise<Response> {
  if (!uuid.test(identity.projectId) || !uuid.test(identity.assetId)) {
    return refuse(400, 'A project and image id are required')
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    return refuse(413, 'Choose an image up to 5 MiB')
  }
  let image: ValidatedImage
  try {
    image = await deps.validate(bytes, claimedType)
  } catch (error) {
    return refuse(
      400,
      error instanceof Error
        ? error.message
        : 'This image could not be decoded',
    )
  }
  if (
    image.byteLength !== bytes.byteLength || image.thumbnail.byteLength === 0 ||
    image.thumbnail.byteLength > 32768
  ) {
    return refuse(400, 'The image preview exceeds its size limit')
  }
  const reserved = await deps.reserve(identity, image)
  if (reserved.error) return databaseRefusal(reserved.error)
  const originalKey = `${identity.projectId}/${identity.assetId}/original`
  const previewKey = `${identity.projectId}/${identity.assetId}/preview`
  try {
    await uploadImmutable(originalKey, bytes, image.mediaType, deps)
    await uploadImmutable(
      previewKey,
      image.thumbnail,
      image.thumbnailType,
      deps,
    )
  } catch {
    return refuse(
      502,
      'The image upload did not finish. Your draft is still on this device. Try again.',
    )
  }
  const completed = await deps.complete(identity, image)
  if (completed.error) return databaseRefusal(completed.error)
  const asset: ImageAsset = {
    id: identity.assetId,
    media_type: image.mediaType,
    byte_length: image.byteLength,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    object_key: originalKey,
    preview_key: previewKey,
    preview_type: image.thumbnailType,
    preview_byte_length: image.thumbnail.byteLength,
  }
  return Response.json({ asset }, { headers: { 'Cache-Control': 'no-store' } })
}
export async function readBoundedBody(
  req: Request,
  maxBytes: number,
  tooLarge: string,
): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > maxBytes) {
    throw new Error(tooLarge)
  }
  if (!req.body) throw new Error('Choose an image')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(tooLarge)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export async function readImageBody(req: Request): Promise<Uint8Array> {
  return await readBoundedBody(
    req,
    MAX_IMAGE_BYTES,
    'Choose an image up to 5 MiB',
  )
}
export async function uploadImageRequest(
  req: Request,
  userId: string,
  deps: ImageDeps,
): Promise<Response> {
  if (req.method !== 'POST') return refuse(405, 'Use POST to upload an image')
  const url = new URL(req.url)
  const identity = {
    projectId: url.searchParams.get('project_id') ?? '',
    assetId: url.searchParams.get('asset_id') ?? '',
    userId,
  }
  if (!uuid.test(identity.projectId) || !uuid.test(identity.assetId)) {
    return refuse(400, 'A project and image id are required')
  }
  let bytes: Uint8Array
  try {
    bytes = await readImageBody(req)
  } catch (error) {
    return refuse(
      413,
      error instanceof Error ? error.message : 'The image could not be read',
    )
  }
  return await storeImage(
    bytes,
    req.headers.get('content-type')?.split(';')[0],
    identity,
    deps,
  )
}
export type CleanupDeps = {
  claim: () => Promise<Answer<unknown>>
  remove: (keys: string[]) => Promise<{ error: { message: string } | null }>
  finish: (keys: string[]) => Promise<{ error: { message: string } | null }>
}
export async function cleanupImages(deps: CleanupDeps): Promise<Response> {
  const batch = await deps.claim()
  if (batch.error) return refuse(502, 'Image cleanup could not start')
  if (
    !Array.isArray(batch.data) ||
    !batch.data.every((key) => typeof key === 'string')
  ) return refuse(502, 'Invalid image cleanup batch')
  const keys = batch.data as string[]
  if (keys.length === 0) return Response.json({ removed: 0 })
  const removed = await deps.remove(keys)
  if (removed.error) return refuse(502, 'Image cleanup will retry')
  const finished = await deps.finish(keys)
  if (finished.error) return refuse(502, 'Image cleanup will retry')
  return Response.json({ removed: keys.length })
}

export type ImportDeps = ImageDeps & {
  readExisting: (identity: ImageIdentity) => Promise<Answer<unknown>>
  importURL: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; mediaType: string | undefined }>
}
export async function importImageRequest(
  req: Request,
  userId: string,
  deps: ImportDeps,
): Promise<Response> {
  if (req.method !== 'POST') return refuse(405, 'Use POST to import an image')
  const projectId = new URL(req.url).searchParams.get('project_id') ?? ''
  if (!uuid.test(projectId)) return refuse(400, 'A project id is required')
  let body: { url: string; asset_id: string }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(
        await readBoundedBody(
          req,
          4096,
          'The image import request is too large',
        ),
      ),
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Use an image URL and image id')
    }
    const input = value as Record<string, unknown>
    if (
      typeof input.url !== 'string' || input.url.length < 1 ||
      input.url.length > 2048 ||
      typeof input.asset_id !== 'string' || !uuid.test(input.asset_id)
    ) throw new Error('Use an image URL and image id')
    body = { url: input.url, asset_id: input.asset_id }
  } catch (error) {
    return refuse(
      400,
      error instanceof Error ? error.message : 'Use an image URL and image id',
    )
  }
  const identity = { projectId, assetId: body.asset_id, userId }
  const existing = await deps.readExisting(identity)
  if (existing.error) return databaseRefusal(existing.error)
  if (existing.data) {
    return Response.json({ asset: existing.data }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  let imported: { bytes: Uint8Array; mediaType: string | undefined }
  try {
    imported = await deps.importURL(body.url)
  } catch (error) {
    return refuse(
      400,
      error instanceof Error
        ? error.message
        : 'The image URL could not be imported',
    )
  }
  return await storeImage(imported.bytes, imported.mediaType, identity, deps)
}
