import { z } from 'npm:zod@4.5.4'
import { ImageAssetSchema, imageDataURL, imageDigest } from '../../../src/features/images/types.ts'
import { inspectImage } from '../../../src/features/images/format.ts'
import { renderingReferences, safePath, type Reference } from './references.ts'

const identity = z.string().uuid()
const positive = z.number().int().positive()
const fileSchema = z.object({ id: identity, path: z.string().refine(safePath), content: z.string(), version: positive,
  kind: z.enum(['text', 'image']), asset: z.unknown().optional() })
const contextSchema = fileSchema.omit({ id: true }).extend({
  id: identity, file_id: identity, project_id: identity, revision: positive, archived: z.boolean(),
})
export type ShareContext = z.infer<typeof contextSchema>
export type FileRecord = z.infer<typeof fileSchema>
type Answer<T> = { data: T | null; error: { code?: string; message?: string } | null }
export type FileShareDeps = {
  context: (token: string) => Promise<Answer<unknown>>
  /** Service-only file_share_dependencies RPC binds every path to this capability's project. */
  read: (token: string, path: string) => Promise<Answer<unknown>>
  download: (key: string) => Promise<Uint8Array | null>
  readMany?: (token: string, paths: string[]) => Promise<Answer<unknown>>
}
export type SharedImage = {
  path: string; dataURL: string; width: number; height: number;
  preview: { dataURL: string; width: number; height: number }
}
export const SHARE_LIMITS = { files: 128, depth: 8, textBytes: 5 * 1024 * 1024, responseBytes: 20 * 1024 * 1024 } as const
export const shareHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
}
const reply = (status: number, error: string) => Response.json({ error }, { status, headers: shareHeaders })
class Refusal extends Error { constructor(readonly status: number, message: string) { super(message) } }
const unavailable = () => new Refusal(404, 'Shared file unavailable')
const tooLarge = () => new Refusal(413, 'This shared file and its embeds exceed the sharing size limit.')
const invalidEmbed = () => new Refusal(409, 'A file needed to render this shared file is missing or invalid.')
const bytes = (text: string) => new TextEncoder().encode(text).byteLength

async function context(token: string, deps: FileShareDeps): Promise<ShareContext> {
  const answer = await deps.context(token)
  if (answer.error || !answer.data) throw unavailable()
  const parsed = contextSchema.safeParse(answer.data)
  if (!parsed.success) throw unavailable()
  return parsed.data
}

async function imageView(file: FileRecord, projectId: string, deps: FileShareDeps): Promise<SharedImage> {
  const metadata = ImageAssetSchema.safeParse(file.asset)
  if (!metadata.success) throw invalidEmbed()
  const asset = metadata.data
  if (asset.object_key !== `${projectId}/${asset.id}/original` || asset.preview_key !== `${projectId}/${asset.id}/preview`) throw invalidEmbed()
  const [original, preview] = await Promise.all([deps.download(asset.object_key), deps.download(asset.preview_key)])
  if (!original || original.length !== asset.byte_length || await imageDigest(original) !== asset.sha256) throw invalidEmbed()
  const info = inspectImage(original, asset.media_type)
  const rotated = info.orientation >= 5 && info.orientation <= 8
  if ((rotated ? info.height : info.width) !== asset.width || (rotated ? info.width : info.height) !== asset.height) throw invalidEmbed()
  if (!preview || preview.length !== asset.preview_byte_length) throw invalidEmbed()
  const thumbnail = inspectImage(preview, asset.preview_type)
  if (thumbnail.width > 480 || thumbnail.height > 480) throw invalidEmbed()
  return {
    path: file.path, dataURL: imageDataURL(original, info.mediaType), width: asset.width, height: asset.height,
    preview: { dataURL: imageDataURL(preview, thumbnail.mediaType), width: thumbnail.width, height: thumbnail.height },
  }
}

/** Every read follows server-parsed saved syntax beneath one checked capability. */
export async function handleFileShare(body: unknown, deps: FileShareDeps): Promise<Response> {
  const shareIdentity = z.object({ id: identity, file_id: identity, path: z.string().refine(safePath), version: positive, revision: positive, archived: z.boolean() }).strict()
  const request = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['manifest', 'image']).optional(), known: shareIdentity.optional(),
    image: z.number().int().min(0).max(SHARE_LIMITS.files - 1).optional(), stream: z.boolean().optional(),
  }).strict().safeParse(body)
  if (!request.success) return reply(404, 'Shared file unavailable')
  try {
    const initial = await context(request.data.token, deps)
    const share = { id: initial.id, file_id: initial.file_id, path: initial.path, version: initial.version, revision: initial.revision, archived: initial.archived }
    const matches = (known: z.infer<typeof shareIdentity>) => Object.entries(share).every(([key, value]) => known[key as keyof typeof known] === value)
    if (request.data.mode === 'image' && (!request.data.known || request.data.image === undefined)) throw unavailable()
    if (request.data.mode === 'image' && !matches(request.data.known!)) throw new Refusal(409, 'This shared file changed while loading.')
    // This context read revalidates the active capability even on unchanged refresh.
    if (request.data.mode === 'manifest' && request.data.known && matches(request.data.known))
      return Response.json({ unchanged: true, share }, { headers: shareHeaders })
    if (request.data.mode === 'manifest' && request.data.stream) return streamManifest(request.data.token, initial, deps)
    const files = new Map<string, FileRecord>()
    const images: SharedImage[] = []
    const imageFiles: FileRecord[] = []
    const pendingImages: Array<{path: string; width: number; height: number}> = []
    const prefetched = new Map<string, unknown>()
    const visiting = new Set<string>()
    let textBytes = 0
    let imageBytes = 0
    const visit = async (file: FileRecord, depth: number): Promise<void> => {
      if (visiting.has(file.path)) throw new Refusal(409, 'This shared file contains circular embeds.')
      if (files.has(file.path)) return
      if (depth > SHARE_LIMITS.depth || files.size >= SHARE_LIMITS.files) throw tooLarge()
      visiting.add(file.path)
      files.set(file.path, file)
      textBytes += bytes(file.content)
      if (textBytes > SHARE_LIMITS.textBytes) throw tooLarge()
      if (file.kind === 'image') {
        if (request.data.mode) {
          const asset = ImageAssetSchema.safeParse(file.asset)
          if (!asset.success || asset.data.object_key !== `${initial.project_id}/${asset.data.id}/original` ||
            asset.data.preview_key !== `${initial.project_id}/${asset.data.id}/preview`) throw invalidEmbed()
          // The same aggregate byte ceiling applies before any progressive bytes leave.
          imageBytes += Math.ceil(asset.data.byte_length / 3) * 4 + Math.ceil(asset.data.preview_byte_length / 3) * 4 + 1024
          if (textBytes + imageBytes > SHARE_LIMITS.responseBytes) throw tooLarge()
          imageFiles.push(file)
          pendingImages.push({path: file.path, width: asset.data.width, height: asset.data.height})
        } else {
        let image: SharedImage
        try { image = await imageView(file, initial.project_id, deps) } catch { throw invalidEmbed() }
        imageBytes += bytes(JSON.stringify(image))
        if (textBytes + imageBytes > SHARE_LIMITS.responseBytes) throw tooLarge()
        images.push(image)
        }
      } else if (/\.(?:md|mdx)$/i.test(file.path) && !/\.excalidraw\.md$/i.test(file.path)) {
        let refs: Reference[]
        try { refs = await renderingReferences(file.content, file.path) } catch { throw invalidEmbed() }
        if (request.data.mode && deps.readMany) {
          const paths = [...new Set(refs.flatMap(ref => ref.kind === 'diagram'
            ? [ref.path, ref.path.replace(/\.d2$/i, '.excalidraw'), `${ref.path}.json`] : [ref.path]))]
            .filter(path => !files.has(path) && !prefetched.has(path))
          if (paths.length + files.size > SHARE_LIMITS.files || depth + 1 > SHARE_LIMITS.depth && paths.length) throw tooLarge()
          if (paths.length) {
            const answer = await deps.readMany(request.data.token, paths)
            if (answer.error || !Array.isArray(answer.data)) throw invalidEmbed()
            for (const path of paths) prefetched.set(path, answer.data.find((record: unknown) =>
              typeof record === 'object' && record !== null && 'path' in record && record.path === path) ?? null)
          }
        }
        for (const ref of refs) {
          await load(ref.path, depth + 1, false, ref.kind)
          if (ref.kind === 'diagram') {
            await load(ref.path.replace(/\.d2$/i, '.excalidraw'), depth + 1, true, 'drawing')
            await load(`${ref.path}.json`, depth + 1, true)
          }
        }
      } else if (/\.d2$/i.test(file.path)) {
        await load(file.path.replace(/\.d2$/i, '.excalidraw'), depth + 1, true, 'drawing')
        await load(`${file.path}.json`, depth + 1, true)
      }
      visiting.delete(file.path)
    }
    const load = async (path: string, depth: number, optional = false, kind?: Reference['kind']): Promise<void> => {
      if (!safePath(path)) throw invalidEmbed()
      if (visiting.has(path)) throw new Refusal(409, 'This shared file contains circular embeds.')
      if (files.has(path)) return
      if (depth > SHARE_LIMITS.depth || files.size >= SHARE_LIMITS.files) throw tooLarge()
      const answer = prefetched.has(path) ? {data: prefetched.get(path), error: null} : await deps.read(request.data.token, path)
      if (answer.error) throw invalidEmbed()
      if (!answer.data) { if (optional) return; throw invalidEmbed() }
      const parsed = fileSchema.safeParse(answer.data)
      if (!parsed.success || parsed.data.path !== path ||
        kind === 'image' && parsed.data.kind !== 'image' || kind && kind !== 'image' && parsed.data.kind !== 'text') throw invalidEmbed()
      await visit(parsed.data, depth)
    }
    await visit({ ...initial, id: initial.file_id }, 0)
    if (textBytes + imageBytes > SHARE_LIMITS.responseBytes) throw tooLarge()
    if (request.data.mode === 'image') {
      const file = imageFiles[request.data.image!]
      if (!file) throw unavailable()
      try { images.push(await imageView(file, initial.project_id, deps)) } catch { throw invalidEmbed() }
    }
    // A revoke, rename, save or dependency change during assembly must never
    // return the old payload. Clients can retry a fresh read after a save.
    const latest = await context(request.data.token, deps)
    if (latest.id !== initial.id || latest.project_id !== initial.project_id || latest.file_id !== initial.file_id) throw unavailable()
    if (latest.revision !== initial.revision || latest.version !== initial.version || latest.path !== initial.path || latest.archived !== initial.archived)
      throw new Refusal(409, 'This shared file changed while loading. Reload to see its latest saved version.')
    const payload = {
      share,
      files: [...files.values()].map(({ id, path, content, version, kind }) => ({ id, path, content: kind === 'image' ? '' : content, version })), images, ...(request.data.mode === 'manifest' ? {pendingImages} : {}),
    }
    const serialized = JSON.stringify(request.data.mode === 'image' ? {share, image: images[0]} : payload)
    if (bytes(serialized) > SHARE_LIMITS.responseBytes) throw tooLarge()
    return new Response(serialized, { headers: { ...shareHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    // Never log a token, source, Storage key or database exception from this
    // capability endpoint. Unexpected failures give no project information.
    if (error instanceof Refusal) return reply(error.status, error.message)
    return reply(502, 'The shared file could not be loaded. Try again.')
  }
}

/** NDJSON preserves aggregate graph limits while complete, validated files can
 * be read before independent descendants or image originals finish. */
function streamManifest(token: string, initial: ShareContext, deps: FileShareDeps): Response {
  let canceled = false
  let onCancel: (() => void) | undefined
  const share = {id: initial.id, file_id: initial.file_id, path: initial.path, version: initial.version,
    revision: initial.revision, archived: initial.archived}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let responseBytes = 0
      const emit = (event: unknown) => {
        if (canceled) return
        const data = encoder.encode(`${JSON.stringify(event)}\n`)
        responseBytes += data.length
        if (responseBytes > SHARE_LIMITS.responseBytes - 1024) throw tooLarge()
        controller.enqueue(data)
      }
      const revalidate = async () => {
        const latest = await context(token, deps)
        if (canceled) return
        if (latest.id !== initial.id || latest.project_id !== initial.project_id || latest.file_id !== initial.file_id) throw unavailable()
        if (latest.revision !== initial.revision || latest.version !== initial.version || latest.path !== initial.path || latest.archived !== initial.archived)
          throw new Refusal(409, 'This shared file changed while loading. Reload to see its latest saved version.')
      }
      void (async () => {
        emit({type: 'start', share})
        const files = new Map<string, FileRecord>()
        const reads = new Map<string, Promise<FileRecord | null>>()
        // Missing and optional identities consume the same bounded graph budget
        // as returned files. Reserve them before publishing or scheduling reads.
        const discovered = new Set<string>([initial.path])
        const scheduled = new Set<string>([initial.path])
        const required = new Set<string>()
        const missing = new Set<string>()
        const expectedKinds = new Map<string, Set<Reference['kind']>>()
        const kindMatches = (file: FileRecord, kind: Reference['kind']) => kind === 'image' ? file.kind === 'image' : file.kind === 'text'
        const queue: Array<() => Promise<void>> = []
        const imageQueue: Array<() => Promise<void>> = []
        const edges = new Map<string, string[]>()
        let active = 0, activeImages = 0, textBytes = 0, imageBytes = 0
        let failure: unknown = null
        let wake: (() => void) | undefined
        const notify = () => {wake?.(); wake = undefined}
        onCancel = notify
        const checkCycles = () => {
          const depths = new Map<string, number>()
          const ancestors = new Set<string>()
          const visit = (path: string): number => {
            if (ancestors.has(path)) throw new Refusal(409, 'This shared file contains circular embeds.')
            if (depths.has(path)) return depths.get(path)!
            ancestors.add(path)
            const depth = Math.max(0, ...(edges.get(path) ?? []).map(child => 1 + visit(child)))
            ancestors.delete(path)
            depths.set(path, depth)
            return depth
          }
          if (visit(initial.path) > SHARE_LIMITS.depth) throw tooLarge()
        }
        const read = async (path: string) => {
          let pending = reads.get(path)
          if (!pending) {
            pending = (async () => {
              const answer = await deps.read(token, path)
              if (canceled) return null
              if (answer.error) throw invalidEmbed()
              if (!answer.data) return null
              const parsed = fileSchema.safeParse(answer.data)
              if (!parsed.success || parsed.data.path !== path) throw invalidEmbed()
              return parsed.data
            })()
            reads.set(path, pending)
          }
          const file = await pending
          if (!file) {missing.add(path); if (required.has(path)) throw invalidEmbed()}
          if (file && [...(expectedKinds.get(path) ?? [])].some(kind => !kindMatches(file, kind))) throw invalidEmbed()
          return file
        }
        const publish = async (file: FileRecord, depth: number): Promise<void> => {
          if (canceled) return
          if (files.has(file.path)) return
          if (depth > SHARE_LIMITS.depth || files.size >= SHARE_LIMITS.files) throw tooLarge()
          files.set(file.path, file)
          textBytes += bytes(file.kind === 'image' ? '' : file.content)
          if (textBytes > SHARE_LIMITS.textBytes) throw tooLarge()
          let references: Array<Reference & {optional?: boolean}> = []
          if (file.kind !== 'image' && /\.(?:md|mdx)$/i.test(file.path) && !/\.excalidraw\.md$/i.test(file.path)) {
            try {references = await renderingReferences(file.content, file.path)} catch {throw invalidEmbed()}
          }
          if (/\.d2$/i.test(file.path)) references.push(
            {path: file.path.replace(/\.d2$/i, '.excalidraw'), kind: 'drawing', optional: true},
            {path: `${file.path}.json`, kind: 'module', optional: true})
          const nextPaths = new Set(discovered)
          for (const ref of references) {
            if (!safePath(ref.path)) throw invalidEmbed()
            nextPaths.add(ref.path)
          }
          if (nextPaths.size > SHARE_LIMITS.files) throw tooLarge()
          for (const ref of references) {
            discovered.add(ref.path)
            if (!ref.optional) required.add(ref.path)
            const kinds = expectedKinds.get(ref.path) ?? new Set<Reference['kind']>()
            kinds.add(ref.kind)
            expectedKinds.set(ref.path, kinds)
            const loaded = files.get(ref.path)
            if (loaded && !kindMatches(loaded, ref.kind) || missing.has(ref.path) && required.has(ref.path)) throw invalidEmbed()
          }
          edges.set(file.path, references.map(ref => ref.path))
          checkCycles()
          const pendingImages: Array<{path: string; width: number; height: number}> = []
          if (file.kind === 'image') {
            const asset = ImageAssetSchema.safeParse(file.asset)
            if (!asset.success || asset.data.object_key !== `${initial.project_id}/${asset.data.id}/original` ||
              asset.data.preview_key !== `${initial.project_id}/${asset.data.id}/preview`) throw invalidEmbed()
            imageBytes += Math.ceil(asset.data.byte_length / 3) * 4 + Math.ceil(asset.data.preview_byte_length / 3) * 4 + 1024
            if (textBytes + imageBytes > SHARE_LIMITS.responseBytes) throw tooLarge()
            pendingImages.push({path: file.path, width: asset.data.width, height: asset.data.height})
          }
          await revalidate()
          if (canceled) return
          emit({type: 'file', file: {id: file.id, path: file.path, content: file.kind === 'image' ? '' : file.content, version: file.version},
            pendingPaths: [...new Set(references.map(ref => ref.path))], pendingImages})
          // Source is published first. Images and sibling dependencies share a
          // bounded queue, so one Storage read never gates an independent file.
          if (file.kind === 'image') imageQueue.push(async () => {
            let image: SharedImage | undefined
            try {image = await imageView(file, initial.project_id, deps)} catch { /* only this image's placeholder fails */ }
            await revalidate()
            if (!canceled) emit(image ? {type: 'image', image} : {type: 'image-error', path: file.path})
          })
          for (const ref of [...references].sort((a, b) => Number(b.kind === 'image') - Number(a.kind === 'image'))) {
            if (depth + 1 > SHARE_LIMITS.depth) throw tooLarge()
            if (scheduled.has(ref.path)) continue
            scheduled.add(ref.path)
            queue.push(async () => {
              try {
                const child = await read(ref.path)
                if (child) await publish(child, depth + 1)
                else {await revalidate(); if (!canceled) emit({type: 'file-absent', path: ref.path})}
              } catch (error) {
                if (error instanceof Refusal && error.status === 413) throw error
                // Missing/invalid descendants stay local. Recheck the link and
                // revision first, so a revoked or changed graph cannot masquerade
                // as an innocuous placeholder failure.
                await revalidate()
                edges.delete(ref.path)
                if (!canceled) emit({type: 'file-error', path: ref.path})
              }
            })
          }
        }
        await publish({...initial, id: initial.file_id}, 0)
        const startQueued = () => {
          while (!canceled && !failure && active < 4 && queue.length) {
            const task = queue.shift()!
            active++
            void task().catch(error => {failure ??= error}).finally(() => {active--; notify()})
          }
        }
        while (!canceled && !failure && (queue.length || active || imageQueue.length || activeImages)) {
          startQueued()
          while (!canceled && !failure && activeImages < 3 && imageQueue.length) {
            const task = imageQueue.shift()!
            activeImages++
            void task().catch(error => {failure ??= error}).finally(() => {activeImages--; notify()})
          }
          if (active || activeImages) await new Promise<void>(resolve => {wake = resolve})
        }
        if (canceled) return
        if (failure) throw failure
        await revalidate()
        if (!canceled) {emit({type: 'complete'}); controller.close()}
      })().catch(error => {
        if (canceled) return
        try {
          // A failed image stays local; graph/auth/revision errors invalidate
          // the partial snapshot and every pending export.
          const refusal = error instanceof Refusal ? error : new Refusal(502, 'The shared file could not be loaded. Try again.')
          controller.enqueue(encoder.encode(`${JSON.stringify({type: 'error', status: refusal.status, error: refusal.message})}\n`))
          controller.close()
        } catch { /* the reader has already canceled */ }
        canceled = true
      })
    },
    cancel() {canceled = true; onCancel?.()},
  })
  return new Response(stream, {headers: {...shareHeaders, 'Content-Type': 'application/x-ndjson'}})
}
