import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build, type Rolldown } from "vite"
import { licenseFileText } from "./third-party-notices"

const root = path.resolve(import.meta.dir, "..")
// The service worker plugin writes its files even when the bundle is not
// written, so this build goes to a scratch folder instead of dist/.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"))
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }))

test("the build's notices cover every bundled package and the adapted code", async () => {
  const { output } = (await build({
    root,
    logLevel: "silent",
    build: { write: false, outDir },
  })) as Rolldown.RolldownOutput
  const notices = output.find((file) => file.fileName === "third-party-notices.txt")
  if (notices?.type !== "asset") throw new Error("the build did not write third-party-notices.txt")
  const text = String(notices.source)

  // Every npm package in the JavaScript bundle, found from its module graph,
  // plus tailwindcss, whose CSS the stylesheet compiles in.
  const packageDirs = new Set([path.join(root, "node_modules", "tailwindcss")])
  for (const file of output) {
    if (file.type !== "chunk") continue
    for (const id of file.moduleIds) {
      // Virtual modules (ids starting with a null byte) are not package files.
      if (id.startsWith("\0")) continue
      const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id)
      if (match) packageDirs.add(match[1])
    }
  }
  expect(packageDirs.size).toBeGreaterThan(5)

  const withoutNotice = [...packageDirs].flatMap((dir) => {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    const license = licenseFileText(dir)
    const listed = text.includes(`\n## ${name} - ${version}`)
    return listed && license !== undefined && text.includes(license) ? [] : [`${name}@${version}`]
  })
  expect(withoutNotice).toEqual([])

  // The Workbox modules the generated service worker ships outside the bundle.
  for (const name of ["workbox-cacheable-response", "workbox-core", "workbox-precaching", "workbox-routing", "workbox-strategies"]) {
    expect(text).toContain(`\n## ${name} - `)
  }
  expect(text).toContain("\n## src/features/comments/anchoring.ts (adapted code)\n")
  expect(text).toContain("Copyright (c) 2013-2019 Hypothes.is Project and contributors")
  expect(text).toContain("2. Redistributions in binary form must reproduce the above copyright notice,")
}, 60_000)
