import { describe, expect, test } from "bun:test"
import { initialFor } from "../ui/AccountRows"

describe("initialFor", () => {
  test("uses the name's first letter, upper case", () => {
    expect(initialFor("person", "someone@example.com")).toBe("P")
  })

  test("falls back to the email when the name is blank", () => {
    expect(initialFor("   ", "zed@example.com")).toBe("Z")
  })

  test("keeps a letter outside the basic plane whole", () => {
    expect(initialFor("𝒜da")).toBe("𝒜")
  })

  test("shows a question mark when there is nothing to go on", () => {
    expect(initialFor("", "")).toBe("?")
  })
})
