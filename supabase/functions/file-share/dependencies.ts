import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'
import type { FileShareDeps } from './handler.ts'

/** No table grants: each service RPC rechecks and binds the share token. */
export function fileShareDependencies(admin: Pick<SupabaseClient, 'rpc' | 'storage'>): FileShareDeps {
  return {
    context: async token => await admin.rpc('file_share_context', { token }),
    read: async (token, path) => {
      const { data, error } = await admin.rpc('file_share_dependencies', { token, paths: [path] })
      return { data: Array.isArray(data) ? data[0] ?? null : null, error }
    },
    download: async key => {
      const { data, error } = await admin.storage.from('project-images').download(key)
      if (error || !data || data.size > 5 * 1024 * 1024) return null
      return new Uint8Array(await data.arrayBuffer())
    },
  }
}
