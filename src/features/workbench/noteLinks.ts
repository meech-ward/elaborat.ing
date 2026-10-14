/**
 * Where a link in a rendered note goes. A web or mail link opens outside the
 * app. A link without a scheme is a path in the project, relative to the
 * note's folder, or to the project's root when it starts with "/", and opens
 * in a tab. A link to a heading in the same note ("#...") stays in the note,
 * and any other scheme goes nowhere.
 */
export type NoteLink = { kind: "web"; url: string } | { kind: "file"; path: string } | { kind: "none" }

export function resolveNoteLink(href: string, notePath: string): NoteLink {
  const value = href.trim()
  if (value === "" || value.startsWith("#") || value.startsWith("//")) return { kind: "none" }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (scheme) {
    if (!["http", "https", "mailto"].includes(scheme[1].toLowerCase())) return { kind: "none" }
    try {
      return { kind: "web", url: new URL(value).href }
    } catch {
      return { kind: "none" }
    }
  }
  let path: string
  try {
    path = decodeURIComponent(value.split(/[?#]/)[0])
  } catch {
    return { kind: "none" }
  }
  const parts = path.startsWith("/") ? [] : notePath.split("/").slice(0, -1)
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (parts.length === 0) return { kind: "none" }
      parts.pop()
    } else parts.push(segment)
  }
  return parts.length > 0 ? { kind: "file", path: parts.join("/") } : { kind: "none" }
}

/**
 * The project file a link names: the path itself, or, for a link written
 * without an extension, the note it means (".mdx", then ".md").
 */
export function linkedFile(path: string, files: readonly string[]): string | null {
  if (files.includes(path)) return path
  if (/\.[^/]+$/.test(path)) return null
  return [`${path}.mdx`, `${path}.md`].find((candidate) => files.includes(candidate)) ?? null
}
