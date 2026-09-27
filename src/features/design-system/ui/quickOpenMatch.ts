// Which files the Go to file palette lists for a query, in what order, and
// which characters it emphasises. Plain functions, no React.

/** A span of matched characters in a label, as [start, end). */
export type MatchRange = readonly [start: number, end: number]

export interface QuickOpenMatch<File> {
  file: File
  /** What the row shows: the file name, or the whole path when the query matched only in its folders. */
  label: string
  /** The folder, shown dim at the row's right end ("" at the project's top). */
  folder: string
  /** The matched characters in `label`, in order, never overlapping. */
  ranges: readonly MatchRange[]
}

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** The query as one run of characters in the text, ignoring case. */
function substring(query: string, text: string): MatchRange[] | null {
  const start = text.toLowerCase().indexOf(query.toLowerCase())
  return start < 0 ? null : [[start, start + query.length]]
}

/** The query's characters in order anywhere in the text, ignoring case; neighbours merge into one range. */
function subsequence(query: string, text: string): MatchRange[] | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const ranges: [number, number][] = []
  let from = 0
  for (const char of q) {
    const at = t.indexOf(char, from)
    if (at < 0) return null
    const last = ranges.at(-1)
    if (last && last[1] === at) last[1] = at + 1
    else ranges.push([at, at + 1])
    from = at + 1
  }
  return ranges
}

/**
 * The files that match the query, best first: the query in a file's name,
 * then in its path, then its letters in order in the name, then in the path.
 * Files keep the given order (recent first, say) within each of those. An
 * empty query lists every file by name.
 */
export function quickOpenMatches<File extends { path: string }>(
  files: readonly File[],
  query: string,
): QuickOpenMatch<File>[] {
  const q = query.trim()
  const ranked: { rank: number; match: QuickOpenMatch<File> }[] = []
  for (const file of files) {
    const { name, folder } = splitPath(file.path)
    if (!q) {
      ranked.push({ rank: 0, match: { file, label: name, folder, ranges: [] } })
      continue
    }
    const tries: [string, (query: string, text: string) => MatchRange[] | null][] = [
      [name, substring],
      [file.path, substring],
      [name, subsequence],
      [file.path, subsequence],
    ]
    const rank = tries.findIndex(([text, match]) => match(q, text) !== null)
    if (rank < 0) continue
    const [label, match] = tries[rank]!
    ranked.push({ rank, match: { file, label, folder, ranges: match(q, label)! } })
  }
  // Array sort is stable, so files keep their order within a rank.
  return ranked.sort((a, b) => a.rank - b.rank).map(({ match }) => match)
}

/** The label cut into plain and matched parts, for rendering. */
export function labelParts(label: string, ranges: readonly MatchRange[]): { text: string; matched: boolean }[] {
  const parts: { text: string; matched: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: label.slice(at, start), matched: false })
    parts.push({ text: label.slice(start, end), matched: true })
    at = end
  }
  if (at < label.length) parts.push({ text: label.slice(at), matched: false })
  return parts
}
