import { describe, expect, test } from "bun:test"
import { menuRows, type MenuEntry } from "./menuRows"

const entry = (label: string, destructive = false): MenuEntry => ({ label, destructive, onSelect: () => {} })
const shape = (entries: MenuEntry[]) =>
  menuRows(entries).map((row) => (row.kind === "separator" ? "---" : row.entry.label))

describe("menuRows", () => {
  test("puts destructive entries last, after one separator", () => {
    expect(shape([entry("Delete", true), entry("Rename"), entry("Duplicate"), entry("Remove", true), entry("Move to…")])).toEqual([
      "Rename",
      "Duplicate",
      "Move to…",
      "---",
      "Delete",
      "Remove",
    ])
  })

  test("adds no separator when one side is empty", () => {
    expect(shape([entry("Rename"), entry("Duplicate")])).toEqual(["Rename", "Duplicate"])
    expect(shape([entry("Delete", true)])).toEqual(["Delete"])
    expect(shape([])).toEqual([])
  })
})
