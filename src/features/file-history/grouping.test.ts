import { describe, expect, test } from "bun:test"
import { formatHistoryDay, formatHistoryTimestamp, groupVersions, historyAuthorName, historyDay, HISTORY_TIME_ZONE } from "./grouping"
import type { FileVersion } from "./remote"

const FILE = "10000000-0000-4000-8000-000000000001"
const AUTHOR = "20000000-0000-4000-8000-000000000001"
const row = (version: number, created_at: string, extra: Partial<FileVersion> = {}): FileVersion => ({
  file_id: FILE, version, created_at, path: "note.md", kind: "text", asset: null, deleted: false, author_id: AUTHOR, ...extra,
})

describe("UTC daily history", () => {
  test("uses UTC at midnight and daylight-saving boundaries regardless of the timestamp offset", () => {
    expect(HISTORY_TIME_ZONE).toBe("UTC")
    expect(historyDay("2026-11-12T23:59:59.999Z")).toBe("2026-11-12")
    expect(historyDay("2026-11-13T00:00:00Z")).toBe("2026-11-13")
    expect(historyDay("2026-11-12T19:00:00-07:00")).toBe("2026-11-13")
    expect(historyDay("2026-11-01T01:30:00-06:00")).toBe(historyDay("2026-11-01T01:30:00-07:00"))
    expect(formatHistoryDay("2026-11-12")).toContain("November 12, 2026")
    expect(formatHistoryTimestamp("2026-11-12T19:00:00-07:00")).toContain("UTC")
    expect(formatHistoryTimestamp("2026-11-12T19:00:00-07:00")).toContain("Nov 13, 2026")
  })

  test("compares before the first save to after the final save and retains every individual revision", () => {
    const versions = [
      row(8, "2026-11-12T10:00:00Z"),
      row(2, "2026-11-11T09:00:00Z"),
      row(9, "2026-11-12T10:00:00Z", { path: "moved.md" }),
      row(5, "2026-11-12T08:00:00Z"),
      row(10, "2026-11-12T12:00:00Z", { deleted: true }),
    ]
    const groups = groupVersions(versions)
    expect(groups.map(group => group.day)).toEqual(["2026-11-12", "2026-11-11"])
    expect(groups[0].versions.map(version => version.version)).toEqual([10, 9, 8, 5])
    expect(groups[0].before?.version).toBe(2)
    expect(groups[0].after.version).toBe(10)
    expect(groups[1].before).toBeNull()
    expect(groups.flatMap(group => group.versions)).toHaveLength(versions.length)
    expect(versions[0].version).toBe(8)
  })

  test("uses an older lookahead across a page boundary without displaying it as a loaded save", () => {
    const previous = row(1, "2026-11-10T12:00:00Z")
    const groups = groupVersions([row(3, "2026-11-12T13:00:00Z"), row(2, "2026-11-12T12:00:00Z")], previous)
    expect(groups[0].before).toEqual(previous)
    expect(groups[0].versions.map(version => version.version)).toEqual([3, 2])
  })

  test("combines a repeated day even when transaction timestamps and revisions cross midnight out of order", () => {
    const versions = [row(4, "2026-11-13T00:00:02Z"), row(3, "2026-11-12T23:59:59Z"), row(2, "2026-11-13T00:00:01Z"), row(1, "2026-11-12T23:59:58Z")]
    const groups = groupVersions(versions)
    expect(groups.map(group => group.day)).toEqual(["2026-11-13", "2026-11-12"])
    expect(groups[0].versions.map(version => version.version)).toEqual([4, 2])
    expect(groups[0].after.version).toBe(4)
    expect(groups.flatMap(group => group.versions).map(version => version.version).sort()).toEqual([1, 2, 3, 4])
  })

  test("names current authors and distinguishes unavailable names from deleted accounts", () => {
    expect(historyAuthorName(AUTHOR, [{ user_id: AUTHOR, email: "ada@example.test", name: "Ada" }])).toBe("Ada")
    expect(historyAuthorName(AUTHOR, [{ user_id: AUTHOR, email: "ada@example.test", name: null }])).toBe("ada@example.test")
    expect(historyAuthorName(AUTHOR, [])).toBe(`Account (${AUTHOR})`)
    expect(historyAuthorName(null, [])).toBe("Deleted account")
  })
})
