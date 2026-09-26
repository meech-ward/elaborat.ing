import { z } from "zod"
import { isValidProjectPath } from "@/features/project-storage/model"

/**
 * Project and file URLs: `/projects/<project id>` and
 * `/projects/<project id>/<file path>`, with each path segment
 * percent-encoded. A separator is never encoded inside a segment.
 */
export type ProjectLocation = { kind: "project"; projectId: string; path: string | null } | { kind: "invalid"; message: string }

const Href = z.string().max(2048)

/** Parse the router's encoded href (not its decoded pathname, which could merge an encoded "/" into a separator). */
export function parseProjectLocation(href: unknown): ProjectLocation {
  const parsed = Href.safeParse(href)
  if (!parsed.success) return invalid("That link is too long.")
  const match = /^\/projects\/([^/?#]+)(?:\/([^?#]*))?(?:[?#].*)?$/.exec(parsed.data)
  if (!match) return invalid("That is not a project link.")
  const projectId = z.uuid().safeParse(match[1])
  if (!projectId.success) return invalid("That link does not name a project.")
  if (match[2] === undefined || match[2] === "") return { kind: "project", projectId: projectId.data, path: null }
  const segments = match[2].split("/")
  if (segments.some((segment) => /%(?:2f|5c)/i.test(segment))) return invalid("That link has an invalid file path.")
  let path: string
  try {
    path = segments.map((segment) => decodeURIComponent(segment)).join("/")
  } catch {
    return invalid("That link has an invalid file path.")
  }
  if (!isValidProjectPath(path)) return invalid("That link has an invalid file path.")
  return { kind: "project", projectId: projectId.data, path }
}

/** The URL of a project, or of one of its files. */
export function projectHref(projectId: string, path: string | null = null): string {
  const base = `/projects/${z.uuid().parse(projectId)}`
  if (path === null) return base
  if (!isValidProjectPath(path)) throw new Error(`Invalid project path: ${path}`)
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`
}

function invalid(message: string): ProjectLocation {
  return { kind: "invalid", message }
}
