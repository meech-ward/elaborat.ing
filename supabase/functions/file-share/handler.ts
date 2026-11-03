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
  const original = await deps.download(asset.object_key)
  if (!original || original.length !== asset.byte_length || await imageDigest(original) !== asset.sha256) throw invalidEmbed()
  const info = inspectImage(original, asset.media_type)
  const rotated = info.orientation >= 5 && info.orientation <= 8
  if ((rotated ? info.height : info.width) !== asset.width || (rotated ? info.width : info.height) !== asset.height) throw invalidEmbed()
  const preview = await deps.download(asset.preview_key)
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
  const request = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(body)
  if (!request.success) return reply(404, 'Shared file unavailable')
  try {
    const initial = await context(request.data.token, deps)
    const files = new Map<string, FileRecord>()
    const images: SharedImage[] = []
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
        let image: SharedImage
        try { image = await imageView(file, initial.project_id, deps) } catch { throw invalidEmbed() }
        imageBytes += bytes(JSON.stringify(image))
        if (textBytes + imageBytes > SHARE_LIMITS.responseBytes) throw tooLarge()
        images.push(image)
      } else if (/\.(?:md|mdx)$/i.test(file.path) && !/\.excalidraw\.md$/i.test(file.path)) {
        let refs: Reference[]
        try { refs = await renderingReferences(file.content, file.path) } catch { throw invalidEmbed() }
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
      const answer = await deps.read(request.data.token, path)
      if (answer.error) throw invalidEmbed()
      if (!answer.data) { if (optional) return; throw invalidEmbed() }
      const parsed = fileSchema.safeParse(answer.data)
      if (!parsed.success || parsed.data.path !== path ||
        kind === 'image' && parsed.data.kind !== 'image' || kind && kind !== 'image' && parsed.data.kind !== 'text') throw invalidEmbed()
      await visit(parsed.data, depth)
    }
    await visit({ ...initial, id: initial.file_id }, 0)
    // A revoke, rename, save or dependency change during assembly must never
    // return the old payload. Clients can retry a fresh read after a save.
    const latest = await context(request.data.token, deps)
    if (latest.id !== initial.id || latest.project_id !== initial.project_id || latest.file_id !== initial.file_id) throw unavailable()
    if (latest.revision !== initial.revision || latest.version !== initial.version || latest.path !== initial.path || latest.archived !== initial.archived)
      throw new Refusal(409, 'This shared file changed while loading. Reload to see its latest saved version.')
    const payload = {
      share: { id: initial.id, file_id: initial.file_id, path: initial.path, version: initial.version, revision: initial.revision, archived: initial.archived },
      files: [...files.values()].map(({ id, path, content, version, kind }) => ({ id, path, content: kind === 'image' ? '' : content, version })), images,
    }
    const serialized = JSON.stringify(payload)
    if (bytes(serialized) > SHARE_LIMITS.responseBytes) throw tooLarge()
    return new Response(serialized, { headers: { ...shareHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    // Never log a token, source, Storage key or database exception from this
    // capability endpoint. Unexpected failures give no project information.
    if (error instanceof Refusal) return reply(error.status, error.message)
    return reply(502, 'The shared file could not be loaded. Try again.')
  }
}
