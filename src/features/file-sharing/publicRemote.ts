import { z } from 'zod/mini'
import { parseConfig } from '@/lib/config'
import { loadClient } from '@/lib/supabase/client'
import { RemoteThread } from '@/features/comments/remote'
import { ProjectPath } from '@/features/project-storage/model'

export const ShareToken = z.string().check(z.regex(/^[a-f0-9]{64}$/))
const Version = z.int().check(z.nonnegative())
const Pixel = z.object({
  dataURL: z.string().check(z.maxLength(7_000_600), z.regex(/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/)),
  width: z.int().check(z.positive()),
  height: z.int().check(z.positive()),
}).check(z.refine(p => p.width * p.height <= 8_000_000))
const ImageDescriptor = z.object({path: ProjectPath, width: z.int().check(z.positive()), height: z.int().check(z.positive())})
  .check(z.refine(p => p.width * p.height <= 8_000_000))
const SharedImageSchema = z.object({path: ProjectPath, ...Pixel.shape, preview: Pixel})
const SharedFileSchema = z.object({id: z.uuid(), path: ProjectPath, content: z.string().check(z.maxLength(5 * 1024 * 1024)), version: Version})
export const SharedBundle = z.object({
  share: z.object({id: z.uuid(), file_id: z.uuid(), path: ProjectPath, version: Version, revision: Version, archived: z.boolean()}),
  files: z.array(SharedFileSchema).check(z.maxLength(128)),
  images: z.array(SharedImageSchema).check(z.maxLength(128)),
  pendingImages: z.optional(z.array(ImageDescriptor).check(z.maxLength(128))),
  complete: z.optional(z.boolean()),
  pendingPaths: z.optional(z.array(ProjectPath).check(z.maxLength(128))),
  fileErrors: z.optional(z.array(ProjectPath).check(z.maxLength(128))),
  imageErrors: z.optional(z.array(ProjectPath).check(z.maxLength(128))),
}).check(z.refine(bundle => {
  const paths = bundle.files.map(f => f.path)
  return new Set(paths).size === paths.length && new Set(bundle.images.map(i => i.path)).size === bundle.images.length &&
    bundle.files.some(f => f.id === bundle.share.file_id && f.path === bundle.share.path && f.version === bundle.share.version) &&
    bundle.files.reduce((sum, f) => sum + f.content.length, 0) <= 5 * 1024 * 1024 &&
    new Set(bundle.pendingImages?.map(image => image.path)).size === (bundle.pendingImages?.length ?? 0) &&
    (bundle.pendingImages ?? []).every(image => paths.includes(image.path))
}))
export type SharedBundle = z.infer<typeof SharedBundle>
export type SharedFile = SharedBundle['files'][number]
export type SharedImage = SharedBundle['images'][number]

export class SharedFileUnavailable extends Error {
  constructor() { super('This link is unavailable. It may have been disabled or replaced, or the file may have been removed.') }
}

/** Anonymous reads never carry the viewer's account session or create membership. */
async function shareRequest(token: string, fields: Record<string, unknown>, signal?: AbortSignal, onProgress?: (bundle: SharedBundle) => void): Promise<unknown> {
  ShareToken.parse(token)
  const config = parseConfig(import.meta.env)
  const response = await fetch(`${config.supabaseUrl}/functions/v1/file-share`, {
    method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: {'Content-Type': 'application/json', apikey: config.supabasePublishableKey},
    body: JSON.stringify({token, ...fields}),
  })
  if (response.status === 403 || response.status === 404) throw new SharedFileUnavailable()
  if (!response.ok) throw new Error(response.status === 413 ? 'This file and its embeds are too large to share in one page.'
    : response.status === 409 ? 'The file changed while loading, or an embedded file is unavailable. Try again or ask the owner to check its embeds.'
    : 'The shared file could not load. Check your connection and try again.')
  if (response.headers.get('Content-Type')?.split(';')[0] === 'application/x-ndjson') return readSharedStream(response, onProgress)
  const limit = 20 * 1024 * 1024
  if (Number(response.headers.get('Content-Length')) > limit) throw new Error('The shared file response is too large.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The shared file response is empty.')
  const decoder = new TextDecoder()
  let text = '', length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) {await reader.cancel(); throw new Error('The shared file response is too large.')}
      text += decoder.decode(chunk.value, {stream: true})
    }
    text += decoder.decode()
  } finally {reader.releaseLock()}
  return JSON.parse(text)
}

export async function readSharedFile(token: string, signal?: AbortSignal): Promise<SharedBundle> {
  return SharedBundle.parse(await shareRequest(token, {}, signal))
}

export function sameSharedRevision(a: SharedBundle['share'], b: SharedBundle['share']): boolean {
  return a.id === b.id && a.file_id === b.file_id && a.version === b.version && a.revision === b.revision && a.path === b.path && a.archived === b.archived
}

export async function readSharedManifest(token: string, known?: SharedBundle['share'], signal?: AbortSignal, onProgress?: (bundle: SharedBundle) => void): Promise<SharedBundle | null> {
  const result = await shareRequest(token, {mode: 'manifest', stream: true, ...(known ? {known} : {})}, signal, onProgress)
  const unchanged = z.object({unchanged: z.literal(true), share: SharedBundle.shape.share}).safeParse(result)
  if (unchanged.success) {
    if (!known || !sameSharedRevision(known, unchanged.data.share)) throw new Error('The shared file revision is invalid.')
    return null
  }
  return SharedBundle.parse(result)
}

export async function readSharedImage(token: string, bundle: SharedBundle, index: number, signal?: AbortSignal): Promise<SharedImage> {
  const descriptor = bundle.pendingImages?.[index]
  if (!descriptor) throw new Error('This image is not included in the shared file.')
  const result = z.object({share: SharedBundle.shape.share, image: SharedImageSchema}).parse(
    await shareRequest(token, {mode: 'image', known: bundle.share, image: index}, signal))
  if (!sameSharedRevision(result.share, bundle.share) || result.image.path !== descriptor.path ||
    result.image.width !== descriptor.width || result.image.height !== descriptor.height)
    throw new Error('The shared file changed while loading.')
  return result.image
}

/** An explicit export completes the frozen manifest before exposing a package. */
export async function completeSharedBundle(token: string, bundle: SharedBundle, signal?: AbortSignal): Promise<SharedBundle> {
  if (bundle.complete === false || bundle.fileErrors?.length || bundle.imageErrors?.length) {
    const complete = await readSharedFile(token, signal)
    if (!sameSharedRevision(complete.share, bundle.share)) throw new Error('The shared file changed while preparing the export.')
    return complete
  }
  const images = [...bundle.images]
  let next = 0
  await Promise.all(Array.from({length: Math.min(3, bundle.pendingImages?.length ?? 0)}, async () => {
    while (next < (bundle.pendingImages?.length ?? 0)) {
      const index = next++
      if (!images.some(image => image.path === bundle.pendingImages![index].path)) images.push(await readSharedImage(token, bundle, index, signal))
    }
  }))
  const result = {...bundle, images, imageErrors: []}
  if (new TextEncoder().encode(JSON.stringify(result)).length > 20 * 1024 * 1024) throw new Error('The shared file response is too large.')
  return result
}


const SharedStreamEvent = z.union([
  z.object({type: z.literal('start'), share: SharedBundle.shape.share}),
  z.object({type: z.literal('file'), file: SharedFileSchema, pendingPaths: z.array(ProjectPath).check(z.maxLength(128)), pendingImages: z.array(ImageDescriptor).check(z.maxLength(128))}),
  z.object({type: z.literal('image'), image: SharedImageSchema}),
  z.object({type: z.literal('image-error'), path: ProjectPath}),
  z.object({type: z.literal('file-error'), path: ProjectPath}),
  z.object({type: z.literal('file-absent'), path: ProjectPath}),
  z.object({type: z.literal('complete')}),
  z.object({type: z.literal('error'), status: z.int(), error: z.string().check(z.maxLength(2000))}),
])

/** A line is parsed only after its complete UTF-8 JSON record arrives. No
 * source prefix or unchecked projection ever reaches a document renderer. */
export async function readSharedStream(response: Response, onProgress?: (bundle: SharedBundle) => void): Promise<SharedBundle> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The shared file response is empty.')
  const decoder = new TextDecoder('utf-8', {fatal: true})
  let buffered = '', received = 0, textBytes = 0
  let share: SharedBundle['share'] | undefined
  let complete = false
  const files = new Map<string, SharedFile>()
  const images = new Map<string, SharedImage>()
  const pendingImages = new Map<string, z.infer<typeof ImageDescriptor>>()
  const pendingPaths = new Set<string>()
  const imageErrors = new Set<string>()
  const fileErrors = new Set<string>()
  const absentPaths = new Set<string>()
  let latest: SharedBundle | undefined
  let fileSnapshot: SharedFile[] = []
  let imageSnapshot: SharedImage[] = []
  let descriptorSnapshot: z.infer<typeof ImageDescriptor>[] = []
  let pathSnapshot: string[] = []
  const accept = (line: string) => {
    const event = SharedStreamEvent.parse(JSON.parse(line))
    if (complete) throw new Error('The shared file response is invalid.')
    if (event.type === 'error') {
      if (event.status === 403 || event.status === 404) throw new SharedFileUnavailable()
      throw new Error(event.status === 409 ? 'The shared file changed while loading, or an embedded file is unavailable. Try again.'
        : event.status === 413 ? 'This file and its embeds are too large to share in one page.' : 'The shared file could not load. Try again.')
    }
    if (event.type === 'start') {
      if (share) throw new Error('The shared file response is invalid.')
      share = event.share
      return
    }
    if (!share) throw new Error('The shared file response is invalid.')
    if (event.type === 'file') {
      if (files.has(event.file.path)) throw new Error('The shared file response is invalid.')
      if (files.size === 0) {
        if (event.file.path !== share.path || event.file.id !== share.file_id || event.file.version !== share.version)
          throw new Error('The shared root file is missing or invalid.')
      } else if (!pendingPaths.has(event.file.path)) throw new Error('The shared file is not declared by its authorized manifest.')
      const declared = new Set([share.path, ...pendingPaths, ...event.pendingPaths])
      if (declared.size > 128) throw new Error('The shared file response is too large.')
      textBytes += new TextEncoder().encode(event.file.content).length
      if (textBytes > 5 * 1024 * 1024 || files.size >= 128) throw new Error('The shared file response is too large.')
      files.set(event.file.path, event.file)
      for (const path of event.pendingPaths) pendingPaths.add(path)
      for (const image of event.pendingImages) {
        if (image.path !== event.file.path) throw new Error('The shared image manifest is invalid.')
        pendingImages.set(image.path, image)
      }
      fileSnapshot = [...files.values()]
      descriptorSnapshot = [...pendingImages.values()]
      pathSnapshot = [...pendingPaths]
    } else if (event.type === 'image') {
      const descriptor = pendingImages.get(event.image.path)
      if (!descriptor || descriptor.width !== event.image.width || descriptor.height !== event.image.height || images.has(event.image.path))
        throw new Error('The shared image manifest is invalid.')
      images.set(event.image.path, event.image)
      imageSnapshot = [...images.values()]
    } else if (event.type === 'image-error') {
      if (!pendingImages.has(event.path)) throw new Error('The shared image manifest is invalid.')
      imageErrors.add(event.path)
    } else if (event.type === 'file-error') {
      if (!pendingPaths.has(event.path)) throw new Error('The shared file manifest is invalid.')
      fileErrors.add(event.path)
    } else if (event.type === 'file-absent') {
      if (!pendingPaths.has(event.path)) throw new Error('The shared file manifest is invalid.')
      absentPaths.add(event.path)
    } else {
      if ([...pendingPaths].some(path => !files.has(path) && !fileErrors.has(path) && !absentPaths.has(path)) ||
        [...pendingImages.keys()].some(path => !images.has(path) && !imageErrors.has(path)))
        throw new Error('The shared file response ended before loading completed.')
      complete = true
    }
    if (!files.has(share.path)) throw new Error('The shared root file is missing.')
    const next = {share, files: fileSnapshot, images: imageSnapshot, pendingImages: descriptorSnapshot,
      pendingPaths: pathSnapshot, imageErrors: [...imageErrors], fileErrors: [...fileErrors], complete}
    SharedBundle.parse(next)
    latest = next
    onProgress?.(latest)
  }
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > 20 * 1024 * 1024) throw new Error('The shared file response is too large.')
      buffered += decoder.decode(value, {stream: true})
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (line) accept(line)
      }
    }
    buffered += decoder.decode()
    if (buffered.trim()) accept(buffered)
    if (!complete || !latest) throw new Error('The shared file response ended before loading completed.')
    return latest
  } catch (error) {await reader.cancel().catch(() => {}); throw error}
  finally {reader.releaseLock()}
}

export const SharedDiscussion = z.object({
  share_id: z.uuid(), file_id: z.uuid(), file_version: Version, archived: z.boolean(), can_moderate: z.boolean(),
  threads: z.array(RemoteThread).check(z.maxLength(1000)),
}).check(z.refine(discussion => discussion.threads.every(thread => [thread.resolved_by, ...thread.comments.map(comment => comment.author)]
  .every(person => person === null || person.email === null && !person.name?.includes('@')) && thread.comments.every(comment => !comment.via_agent))))
export type SharedDiscussion = z.infer<typeof SharedDiscussion>

/** Bind each write to the account that initiated it, across sign-in changes. */
export async function shareCommentRPC(name: string, args: Record<string, unknown>, userId?: string, clientLoader = loadClient): Promise<unknown> {
  const client = await clientLoader()
  let authorization: string | undefined
  if (userId) {
    const {data, error} = await client.auth.getSession()
    if (error || data.session?.user.id !== userId) throw new Error('Your account changed. Try again from the current account.')
    authorization = `Bearer ${data.session.access_token}`
  }
  let request = client.rpc(name, args)
  if (authorization) request = request.setHeader('Authorization', authorization)
  const {data, error} = await request
  if (error) {
    if (error.code === '42501') throw new SharedFileUnavailable()
    throw new Error(error.message)
  }
  return data
}

export async function readSharedDiscussion(token: string): Promise<SharedDiscussion> {
  return SharedDiscussion.parse(await shareCommentRPC('list_file_share_comments', {token}))
}
