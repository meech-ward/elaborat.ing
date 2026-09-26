import { expect, test } from "bun:test"
import { parseProjectLocation, projectHref } from "./location"

const projectId = "00000000-0000-4000-8000-000000000010"

test("project and file links round-trip exactly", () => {
  for (const path of [null, "index.mdx", "notes/日本語 café %20 #?.mdx", "100% done.excalidraw", "a b/c+d&e=f.md", "flow.d2"]) {
    expect(parseProjectLocation(projectHref(projectId, path))).toEqual({ kind: "project", projectId, path })
  }
  expect(projectHref(projectId, "notes/a b.md")).toBe(`/projects/${projectId}/notes/a%20b.md`)
})

test("a query or fragment on a project link is ignored", () => {
  expect(parseProjectLocation(`/projects/${projectId}/a.md?x=1#top`)).toEqual({ kind: "project", projectId, path: "a.md" })
})

test("malformed, foreign and traversal links are refused", () => {
  for (const href of [
    null,
    {},
    "/",
    "https://other.test/projects/x/a.md",
    "/unknown/a.md",
    "/projects/not-a-uuid/a.md",
    `/projects/${projectId}/../a.md`,
    `/projects/${projectId}/%2e%2e/a.md`,
    `/projects/${projectId}/a%2fb.md`,
    `/projects/${projectId}/a%5cb.md`,
    `/projects/${projectId}/.secret.md`,
    `/projects/${projectId}/a%.md`,
    `/projects/${projectId}/a//b.md`,
    `/projects/${projectId}/a/`,
  ]) {
    expect(parseProjectLocation(href).kind, String(href)).toBe("invalid")
  }
  expect(() => projectHref(projectId, "../a.md")).toThrow()
})
