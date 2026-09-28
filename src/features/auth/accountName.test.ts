import { expect, test } from "bun:test"
import { accountName, personName } from "./accountName"

test("a name set in Settings comes first, then a provider's full name, then its name", () => {
  expect(accountName({ display_name: "Ada", full_name: "Ada Lovelace", name: "ada" })).toBe("Ada")
  expect(accountName({ full_name: "Ada Lovelace", name: "ada" })).toBe("Ada Lovelace")
  expect(accountName({ name: "ada" })).toBe("ada")
})

test("blank or missing names give none, and names are tidied and cut to 80 characters", () => {
  expect(accountName({ display_name: "   ", full_name: "", name: 7 })).toBeNull()
  expect(accountName({})).toBeNull()
  expect(accountName(undefined)).toBeNull()
  expect(accountName({ display_name: "  Ada \n  Lovelace " })).toBe("Ada Lovelace")
  expect(accountName({ display_name: "x".repeat(100) })).toBe("x".repeat(80))
})

test("a person is called by their account's name, else their email, the same everywhere", () => {
  expect(personName("Ada Lovelace", "ada@example.com")).toBe("Ada Lovelace")
  expect(personName(null, "ada@example.com")).toBe("ada@example.com")
  expect(personName("  ", "ada@example.com")).toBe("ada@example.com")
  expect(personName(undefined, null)).toBeNull()
})
