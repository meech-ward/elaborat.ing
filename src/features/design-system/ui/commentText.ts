// The words around a comment: how long ago it was written, and how close a
// draft is to the length limit. Pure, so the rules are tested without React.

/** The longest comment the database takes, in characters (code points). */
export const COMMENT_MAX_LENGTH = 100_000

/** The share of the limit from which the composer shows the count. */
const SHOW_FROM = 0.9

export type CommentLength = {
  /** Characters as the database counts them: code points, so an emoji is one. */
  count: number
  /** Near or over the limit: show the count. */
  show: boolean
  over: boolean
  /** Not blank and within the limit. */
  sendable: boolean
}

export function commentLength(text: string, max: number = COMMENT_MAX_LENGTH): CommentLength {
  const count = Array.from(text).length
  const over = count > max
  return { count, show: count >= Math.ceil(max * SHOW_FROM), over, sendable: /\S/.test(text) && !over }
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
const dayMonth = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" })
const dayMonthYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" })
const full = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * When something happened, as a comment shows it: "just now", "5 minutes
 * ago", "3 hours ago", "yesterday", "4 days ago", then the date ("Sep 12",
 * with the year when it is not this year's). A time a little in the future
 * (another device's clock) reads as just now.
 */
export function relativeTime(when: string | Date, now: Date = new Date()): string {
  const then = new Date(when)
  const ago = now.getTime() - then.getTime()
  if (ago < 45_000) return "just now"
  if (ago < HOUR) return relative.format(-Math.max(1, Math.round(ago / MINUTE)), "minute")
  if (ago < DAY) return relative.format(-Math.round(ago / HOUR), "hour")
  if (ago < 7 * DAY) return relative.format(-Math.round(ago / DAY), "day")
  return (then.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(then)
}

/** The full date and time, for a tooltip: "Sep 27, 2026, 3:04 PM". */
export function absoluteTime(when: string | Date): string {
  return full.format(new Date(when))
}
