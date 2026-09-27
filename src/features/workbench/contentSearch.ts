/**
 * A passage as the `search` Edge Function returns it (see
 * supabase/functions/search/handler.ts), best match first. Search covers every
 * project the person can read, or the one it is given.
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
 * Markdown or MDX as the words a reader sees: frontmatter at the start, MDX
 * import and export lines, headings, list and quote marks, emphasis, code
 * marks, links, tags and table rules are dropped.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/^(?:import|export)\s.*$/gm, "")
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/gm, "")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<!\w)([*_])(?=\S)([^*_\n]+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\|/g, " ")
}

/**
 * About `width` characters of `text`, as plain text, around the earliest word
 * of `query` it contains, split so the match can be shown in bold. A passage
 * found by meaning alone may contain no word of the query: then it is the start.
 */
export function snippet(text: string, query: string, width = 120): { before: string; match: string; after: string } {
  const flat = plainText(text).replace(/\s+/g, " ").trim()
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
