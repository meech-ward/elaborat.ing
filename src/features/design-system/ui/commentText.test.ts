import { describe, expect, test } from "bun:test"
import { COMMENT_MAX_LENGTH, commentLength, relativeTime } from "./commentText"

describe("commentLength", () => {
  test("hides the count well under the limit, and a blank draft can't be sent", () => {
    expect(commentLength("")).toEqual({ count: 0, show: false, over: false, sendable: false })
    expect(commentLength("  \n ")).toMatchObject({ sendable: false })
    expect(commentLength("Is this still true?")).toMatchObject({ count: 19, show: false, sendable: true })
  })

  test("shows the count from 90% of the limit, and refuses a draft over it", () => {
    expect(commentLength("a".repeat(4499))).toMatchObject({ show: false, sendable: true })
    expect(commentLength("a".repeat(4500))).toMatchObject({ show: true, over: false, sendable: true })
    expect(commentLength("a".repeat(COMMENT_MAX_LENGTH))).toMatchObject({ show: true, over: false, sendable: true })
    expect(commentLength("a".repeat(COMMENT_MAX_LENGTH + 1))).toMatchObject({ count: 5001, show: true, over: true, sendable: false })
  })

  test("counts characters as the database does: an emoji is one", () => {
    expect(commentLength("👍".repeat(COMMENT_MAX_LENGTH)).over).toBe(false)
    expect(commentLength("👍👍").count).toBe(2)
  })
})

describe("relativeTime", () => {
  const now = new Date("2026-09-27T15:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  test("reads recent times in words", () => {
    expect(relativeTime(ago(10_000), now)).toBe("just now")
    expect(relativeTime(ago(-60_000), now)).toBe("just now")
    expect(relativeTime(ago(60_000), now)).toBe("1 minute ago")
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5 minutes ago")
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3 hours ago")
    expect(relativeTime(ago(26 * 3_600_000), now)).toBe("yesterday")
    expect(relativeTime(ago(4 * 86_400_000), now)).toBe("4 days ago")
  })

  test("gives the date after a week, with the year only when it differs", () => {
    expect(relativeTime("2026-09-12T12:00:00Z", now)).toBe("Sep 12")
    expect(relativeTime("2025-12-03T12:00:00Z", now)).toBe("Dec 3, 2025")
  })
})
