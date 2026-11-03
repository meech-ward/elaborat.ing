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
export const SharedBundle = z.object({
  share: z.object({id: z.uuid(), file_id: z.uuid(), path: ProjectPath, version: Version, revision: Version, archived: z.boolean()}),
  files: z.array(z.object({id: z.uuid(), path: ProjectPath, content: z.string().check(z.maxLength(5 * 1024 * 1024)), version: Version})).check(z.maxLength(128)),
  images: z.array(z.object({path: ProjectPath, ...Pixel.shape, preview: Pixel})).check(z.maxLength(128)),
}).check(z.refine(bundle => {
  const paths = bundle.files.map(f => f.path)
  return new Set(paths).size === paths.length && new Set(bundle.images.map(i => i.path)).size === bundle.images.length &&
    bundle.files.some(f => f.id === bundle.share.file_id && f.path === bundle.share.path && f.version === bundle.share.version) &&
    bundle.files.reduce((sum, f) => sum + f.content.length, 0) <= 5 * 1024 * 1024
}))
export type SharedBundle = z.infer<typeof SharedBundle>
export type SharedFile = SharedBundle['files'][number]
export type SharedImage = SharedBundle['images'][number]

export class SharedFileUnavailable extends Error {
  constructor() { super('This link is unavailable. It may have been disabled or replaced, or the file may have been removed.') }
}

/** Anonymous reads never carry the viewer's account session or create membership. */
export async function readSharedFile(token: string, signal?: AbortSignal): Promise<SharedBundle> {
  ShareToken.parse(token)
  const config = parseConfig(import.meta.env)
  const response = await fetch(`${config.supabaseUrl}/functions/v1/file-share`, {
    method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: {'Content-Type': 'application/json', apikey: config.supabasePublishableKey},
    body: JSON.stringify({token}),
  })
  if (response.status === 403 || response.status === 404) throw new SharedFileUnavailable()
  if (!response.ok) throw new Error(response.status === 413 ? 'This file and its embeds are too large to share in one page.'
    : response.status === 409 ? 'The file changed while loading, or an embedded file is unavailable. Try again or ask the owner to check its embeds.'
    : 'The shared file could not load. Check your connection and try again.')
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
  return SharedBundle.parse(JSON.parse(text))
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
