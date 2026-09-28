import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

// The component files (.mdx) a note or a component file imports with
// `workspace:` specifiers, read as the user so RLS applies, for the view to
// preview. The view compiles them with the app's own rules
// (src/features/document/componentModules.ts), which also refuse what this
// finds but should not have: this only finds the paths named after `from`,
// and a file that is not there is left for the view to report. The limits
// are the app's: 8 levels of imports, 32 files and 2 MiB of source.

/** The result `_meta` key holding the component files to preview, by path. */
export const COMPONENTS_META_KEY = 'elaborat.ing/components'

const MAX_DEPTH = 8
const MAX_FILES = 32
const MAX_BYTES = 2 * 1024 * 1024

const IMPORT = /\bfrom\s*(["'])workspace:([^"'\n]{1,512})\1/g

/** The component file paths a source imports, as the app accepts them: .mdx, no empty, dot or dot-dot segments. */
export function importedPaths(source: string): string[] {
  const paths = new Set<string>()
  for (const [, , path] of source.matchAll(IMPORT)) {
    if (/\.mdx$/i.test(path) && !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split('/').every((part) => part && !part.startsWith('.'))) paths.add(path)
  }
  return [...paths]
}

/**
 * The sources of the component files `source` imports, and the files they
 * import, level by level with one query each, within the app's limits.
 * `known` holds sources already in hand (a draft of the file itself).
 */
export async function componentSources(
  supabase: SupabaseClient,
  projectId: string,
  source: string,
  known: Record<string, string> = {}
): Promise<Record<string, string>> {
  const found: Record<string, string> = { ...known }
  let bytes = new TextEncoder().encode(source).byteLength
  let wanted = importedPaths(source)
  for (let depth = 0; depth < MAX_DEPTH && wanted.length > 0; depth++) {
    const missing = wanted.filter((path) => !(path in found)).slice(0, Math.max(0, MAX_FILES - Object.keys(found).length))
    const next: string[] = []
    if (missing.length > 0) {
      const { data, error } = await supabase
        .from('project_files')
        .select('path, content')
        .eq('project_id', projectId)
        .in('path', missing)
      if (error) throw error
      for (const row of data ?? []) {
        const content = String(row.content ?? '')
        bytes += new TextEncoder().encode(content).byteLength
        if (bytes > MAX_BYTES) return found
        found[row.path] = content
      }
    }
    for (const path of wanted) if (path in found) next.push(...importedPaths(found[path]))
    wanted = [...new Set(next)].filter((path) => !(path in found))
  }
  return found
}

/**
 * Whether a project is shared with the user rather than their own, so the
 * view asks before it runs the project's custom component code. Unknown
 * counts as shared.
 */
export async function sharedWithUser(supabase: SupabaseClient, projectId: string, userId: string | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('projects').select('owner_id').eq('id', projectId).maybeSingle()
    return Boolean(error) || !data || !userId || data.owner_id !== userId
  } catch {
    return true
  }
}

/**
 * Who last changed each of these files, by path, named as list_members names
 * them ("you" for the user), for the view to show beside the files whose code
 * it asks about. Files and people it cannot name are left out; when the
 * server cannot say, none are named.
 */
export async function componentEditors(
  supabase: SupabaseClient,
  projectId: string,
  paths: string[],
  userId: string | undefined
): Promise<Record<string, string>> {
  try {
    const [files, members] = await Promise.all([
      supabase.from('project_files').select('path, updated_by').eq('project_id', projectId).in('path', paths),
      supabase.rpc('list_members', { project_id: projectId }),
    ])
    if (files.error || members.error) return {}
    const names = new Map<string, string>()
    for (const member of (members.data ?? []) as { user_id?: unknown; name?: unknown; email?: unknown }[]) {
      const name = typeof member.name === 'string' && member.name ? member.name : typeof member.email === 'string' ? member.email : ''
      if (typeof member.user_id === 'string' && name) names.set(member.user_id, member.user_id === userId ? 'you' : name)
    }
    const editors: Record<string, string> = {}
    for (const row of (files.data ?? []) as { path: string; updated_by: string | null }[]) {
      const name = row.updated_by ? names.get(row.updated_by) : undefined
      if (name) editors[row.path] = name
    }
    return editors
  } catch {
    return {}
  }
}
