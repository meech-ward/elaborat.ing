import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CARD_BUILDS, keepCardBuilds, listedCardBuilds } from "./chat-card-builds.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Build n's files: its own editor module, and a font every build shares. */
const build = (n: number) => new Map([[`editor-${n}.js`, `editor(${n})`], ["font.woff2", "font"]])
const names = (n: number) => [...build(n).keys()].sort()

/** public/chat-card as the last commit left it: builds `ns`, newest first, and their files, which `restore` reads back. */
function committedFolder(ns: number[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chat-card-builds-"))
  dirs.push(dir)
  const files = new Map(ns.flatMap((n) => [...build(n)]))
  for (const [name, text] of files) writeFileSync(path.join(dir, name), text)
  const committed = ns.map(names)
  writeFileSync(path.join(dir, CARD_BUILDS), `${JSON.stringify({ builds: committed }, null, 2)}\n`)
  return { dir, committed, restore: (name: string) => new TextEncoder().encode(files.get(name)) }
}

const contents = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]))

test("a new build keeps the nine before it and removes the files only an older one had; a file they share stays, once", () => {
  const { dir, committed } = committedFolder([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  const kept = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
  expect(keepCardBuilds(dir, build(10), committed)).toEqual(kept.map(names))
  expect(listedCardBuilds(JSON.parse(readFileSync(path.join(dir, CARD_BUILDS), "utf8")))).toEqual(kept.map(names))
  // A view of the build before still finds its editor, and so does one of build 1, nine builds back; build 0's is gone.
  expect(existsSync(path.join(dir, "editor-9.js"))).toBe(true)
  expect(existsSync(path.join(dir, "editor-1.js"))).toBe(true)
  expect(existsSync(path.join(dir, "editor-0.js"))).toBe(false)
  expect(readdirSync(dir).sort()).toEqual([CARD_BUILDS, "font.woff2", ...kept.map((n) => `editor-${n}.js`)].sort())
})

test("builds between commits replace each other, not the committed ones; the committed build again changes nothing and brings back what they removed", () => {
  const { dir, committed, restore } = committedFolder([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  const atCommit = contents(dir)
  keepCardBuilds(dir, build(10), committed, restore)
  expect(keepCardBuilds(dir, build(11), committed, restore)).toEqual([11, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(names))
  expect(existsSync(path.join(dir, "editor-10.js"))).toBe(false)
  expect(keepCardBuilds(dir, build(9), committed, restore)).toEqual(committed)
  expect(contents(dir)).toEqual(atCommit)
})

test("a build the same as an older one moves first, listed once; a builds.json from before builds were counted lists current, then previous", () => {
  const { dir, committed } = committedFolder([2, 1, 0])
  expect(keepCardBuilds(dir, build(1), committed)).toEqual([1, 2, 0].map(names))
  expect(listedCardBuilds({ current: ["b.js"], previous: ["a.js"] })).toEqual([["b.js"], ["a.js"]])
  expect(listedCardBuilds({ current: ["a.js"], previous: [] })).toEqual([["a.js"]])
  expect(listedCardBuilds(null)).toEqual([])
})
