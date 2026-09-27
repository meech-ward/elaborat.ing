/**
 * A passage as the `search` Edge Function returns it (see
 * supabase/functions/search/handler.ts). Search covers every project the
 * person can read, best match first.
 */
export type SearchPassage = { project_id: string; path: string; content: string }

/** One matching file, with the text of its best passage. */
export type FileSearchHit = { path: string; text: string }

/** The files of one project among search passages, best first, each once. */
export function projectHits(passages: SearchPassage[], projectId: string): FileSearchHit[] {
  const hits = new Map<string, FileSearchHit>()
  for (const passage of passages) {
    if (passage.project_id !== projectId || hits.has(passage.path)) continue
    hits.set(passage.path, { path: passage.path, text: passage.content })
  }
  return [...hits.values()]
}

/**
 * About `width` characters of `text` around the earliest word of `query` it
 * contains, split so the match can be shown in bold. A passage found by
 * meaning alone may contain no word of the query: then it is the start.
 */
export function snippet(text: string, query: string, width = 120): { before: string; match: string; after: string } {
  const flat = text.replace(/\s+/g, " ").trim()
  const lower = flat.toLowerCase()
  let at = -1
  let length = 0
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const index = lower.indexOf(word)
    if (index !== -1 && (at === -1 || index < at)) {
      at = index
      length = word.length
    }
  }
  if (at === -1) return { before: flat.length > width ? `${flat.slice(0, width)}…` : flat, match: "", after: "" }
  const start = Math.max(0, Math.min(at - Math.floor((width - length) / 3), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return {
    before: `${start > 0 ? "…" : ""}${flat.slice(start, at)}`,
    match: flat.slice(at, at + length),
    after: `${flat.slice(at + length, end)}${end < flat.length ? "…" : ""}`,
  }
}
