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
