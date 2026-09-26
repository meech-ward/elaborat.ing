import { expect, test } from "bun:test"
import { safeNextPath } from "@/lib/safe-next-path"
import { emailLinkRedirect } from "./returnPath"

const origin = "https://elaborat.ing"

test("only paths on this site are followed after signing in", () => {
  expect(safeNextPath("/oauth/consent?authorization_id=abc", "/", origin)).toBe("/oauth/consent?authorization_id=abc")
  for (const next of ["https://evil.example/", "//evil.example/x", "javascript:alert(1)", "oauth/consent", null, undefined, 42]) {
    expect(safeNextPath(next, "/", origin)).toBe("/")
  }
  expect(safeNextPath("/\\evil.example", "/", origin)).toBe("/")
})

test("an emailed sign-in link returns to the sign-in page with the page to continue to", () => {
  expect(emailLinkRedirect(origin, "/oauth/consent?authorization_id=abc")).toBe(
    "https://elaborat.ing/sign-in?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dabc",
  )
  expect(emailLinkRedirect(origin, null)).toBe("https://elaborat.ing/sign-in")
  expect(emailLinkRedirect(origin, "https://evil.example/")).toBe("https://elaborat.ing/sign-in")
})
