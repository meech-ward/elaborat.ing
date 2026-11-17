import { personName } from "../auth/accountName"
import type { FileHistoryAuthor, FileVersion } from "./remote"

/** Grouping and every displayed time use the same explicit timezone. */
export const HISTORY_TIME_ZONE = "UTC"

export function historyDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export type FileHistoryDay = {
  day: string
  /** Every underlying save, newest revision first. Grouping never compacts records. */
  versions: FileVersion[]
  /** The preceding loaded revision; use remote.predecessor for an authoritative diff boundary. */
  before: FileVersion | null
  /** The last saved state of this day. */
  after: FileVersion
}

export function groupVersions(versions: readonly FileVersion[], previous: FileVersion | null = null): FileHistoryDay[] {
  const ordered = [...versions].sort((a, b) => b.version - a.version)
  const groups = new Map<string, FileHistoryDay>()
  for (const [index, version] of ordered.entries()) {
    const day = historyDay(version.created_at)
    const last = groups.get(day)
    const before = ordered[index + 1] ?? previous
    if (last) {
      last.versions.push(version)
      last.before = before
    } else groups.set(day, { day, versions: [version], before, after: version })
  }
  return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day))
}

export function formatHistoryDay(day: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: HISTORY_TIME_ZONE }).format(new Date(`${day}T00:00:00Z`))
}

export function formatHistoryTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium", timeStyle: "long", timeZone: HISTORY_TIME_ZONE,
  }).format(new Date(timestamp))
}

/** Membership supplies names, but absence from today's member list is not a deleted account. */
export function historyAuthorName(authorId: string | null, authors: readonly FileHistoryAuthor[]): string {
  if (authorId === null) return "Deleted account"
  const author = authors.find(person => person.user_id === authorId)
  return author ? personName(author.name, author.email) ?? `Account (${authorId})` : `Account (${authorId})`
}
