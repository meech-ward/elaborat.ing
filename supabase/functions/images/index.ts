import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'
import { withSupabase } from 'npm:@supabase/server@1.6.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import { validateImage } from '../_shared/images.ts'
import { importImageURL } from '../_shared/imageImport.ts'
import {
  cleanupImages,
  databaseRefusal,
  type ImageDeps,
  importImageRequest,
  uploadImageRequest,
} from './handler.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const upload = withSupabase({ auth: 'user' }, async (req, ctx) => {
  const db: SupabaseClient = ctx.supabase
  const admin: SupabaseClient = ctx.supabaseAdmin
  const url = new URL(req.url)
  const projectId = url.searchParams.get('project_id')
  if (
    !projectId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      projectId,
    )
  ) return Response.json({ error: 'A project id is required' }, { status: 400 })
  // Permission and rate limits precede decoding or allocating image pixels.
  const allowed = await db.rpc('check_image_upload', { project_id: projectId })
  if (allowed.error) return databaseRefusal(allowed.error)
  const metadata = (
    identity: Parameters<ImageDeps['reserve']>[0],
    image: Parameters<ImageDeps['reserve']>[1],
  ) => ({
    asset_id: identity.assetId,
    sha256: image.sha256,
    media_type: image.mediaType,
    byte_length: image.byteLength,
    width: image.width,
    height: image.height,
    preview_type: image.thumbnailType,
    preview_byte_length: image.thumbnail.byteLength,
  })
  const deps: ImageDeps = {
    validate: validateImage,
    reserve: async (identity, image) =>
      await db.rpc('reserve_image_asset', {
        project_id: identity.projectId,
        ...metadata(identity, image),
      }),
    complete: async (identity, image) =>
      await admin.rpc('complete_image_asset', {
        user_id: identity.userId,
        ...metadata(identity, image),
      }),
    upload: async (key, bytes, mediaType) =>
      await admin.storage.from('project-images').upload(key, bytes, {
        contentType: mediaType,
        upsert: false,
        cacheControl: '31536000',
      }),
    download: async (key) => {
      const { data, error } = await admin.storage.from('project-images')
        .download(key)
      if (error || !data) return null
      return new Uint8Array(await data.arrayBuffer())
    },
  }
  if (url.searchParams.get('import') === '1') {
    return await importImageRequest(req, ctx.userClaims!.id, {
      ...deps,
      importURL: importImageURL,
      readExisting: async (identity) =>
        await db.rpc('read_image_upload', {
          project_id: identity.projectId,
          asset_id: identity.assetId,
        }),
    })
  }
  return await uploadImageRequest(req, ctx.userClaims!.id, deps)
})
const cleanup = withSupabase({ auth: 'secret:*' }, async (req, ctx) => {
  const admin: SupabaseClient = ctx.supabaseAdmin
  if (req.method !== 'POST') {
    return new Response('expected POST request', { status: 405 })
  }
  return await cleanupImages({
    claim: async () => await admin.rpc('claim_image_cleanup'),
    remove: async (keys) =>
      await admin.storage.from('project-images').remove(keys),
    finish: async (keys) =>
      await admin.rpc('finish_image_cleanup', { object_keys: keys }),
  })
})
export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const response = new URL(req.url).searchParams.get('cleanup') === '1'
      ? await cleanup(req)
      : await upload(req)
    for (const [name, value] of Object.entries(cors)) {
      response.headers.set(name, value)
    }
    return response
  },
}
