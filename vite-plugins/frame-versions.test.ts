import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FRAME_VERSIONS, keepFrameVersions, pageFolder, writeFrameVersions, type FrameVersion } from "./frame-versions.ts"

const ORIGIN = "https://usercontent.test"
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A version's files, named after their contents as a build names them. */
function version(n: number): { version: FrameVersion; files: Record<string, string> } {
  const files = { "index.html": `<!doctype html><title>${n}</title>`, "frame.js": `frame(${n})`, "charts.js": `charts(${n})` }
  return { version: { folder: pageFolder(files), files: Object.keys(files) }, files }
}

/** The sandbox domain: its list of versions and their files, as the Worker serves them (a folder's page at its path). */
function domain(listed: unknown[], served: Array<ReturnType<typeof version>>) {
  const paths = new Map<string, string>([[`/${FRAME_VERSIONS}`, JSON.stringify({ versions: listed })]])
  for (const { version, files } of served) for (const [name, text] of Object.entries(files)) paths.set(`/${version.folder}${name === "index.html" ? "" : name}`, text)
  return async (url: string) => {
    const body = paths.get(new URL(url).pathname)
    return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body)
  }
}

/** A build's sandbox folder, with its own version. */
function build(current: ReturnType<typeof version>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "frame-versions-"))
  dirs.push(dir)
  mkdirSync(path.join(dir, current.version.folder), { recursive: true })
  for (const [name, text] of Object.entries(current.files)) writeFileSync(path.join(dir, current.version.folder, name), text)
  writeFrameVersions(dir, [current.version])
  return dir
}

const listed = (dir: string) => (JSON.parse(readFileSync(path.join(dir, FRAME_VERSIONS), "utf8")) as { versions: FrameVersion[] }).versions

test("keeps the domain's latest earlier versions after this build's, five in all, each only when its files match its name", async () => {
  const [current, ...earlier] = [7, 6, 5, 4, 3, 2, 1, 0].map(version)
  // 6 is served with other contents and 5 without one of its files.
  const changed = { ...earlier[0], files: { ...earlier[0].files, "frame.js": "changed()" } }
  const incomplete = { ...earlier[1], files: Object.fromEntries(Object.entries(earlier[1].files).filter(([name]) => name !== "charts.js")) }
  const notAVersion = { folder: "../../etc/", files: ["index.html"] }
  const live = [current.version, notAVersion, ...earlier.map((entry) => entry.version)]
  const dir = build(current)
  const { kept, problems } = await keepFrameVersions(dir, ORIGIN, domain(live, [current, changed, incomplete, ...earlier.slice(2)]))

  // 7 (this build), then 4, 3, 2 and 1: 6 and 5 are left out, and 0 is past the bound.
  const keptEarlier = earlier.slice(2, 6)
  const expected = [current, ...keptEarlier].map((entry) => entry.version.folder)
  expect(kept).toEqual(expected)
  expect(listed(dir).map((entry) => entry.folder)).toEqual(expected)
  for (const { version: { folder }, files } of keptEarlier)
    for (const [name, text] of Object.entries(files)) expect(readFileSync(path.join(dir, folder, name), "utf8")).toBe(text)
  for (const left of [earlier[0], earlier[1], earlier[6]]) expect(existsSync(path.join(dir, left.version.folder))).toBe(false)
  expect(problems).toEqual([
    `Left out ${JSON.stringify(notAVersion)}: not a frame version.`,
    `Left out ${earlier[0].version.folder} (its files do not match its name).`,
    `Left out ${earlier[1].version.folder} (charts.js: status 404).`,
  ])
})

test("without the domain's list, only this build's version is listed", async () => {
  const current = version(1)
  const dir = build(current)
  const { kept, problems } = await keepFrameVersions(dir, ORIGIN, async () => new Response("Not found", { status: 404 }))
  expect(kept).toEqual([current.version.folder])
  expect(listed(dir)).toEqual([current.version])
  expect(problems).toHaveLength(1)
})
