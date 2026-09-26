import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { build, type Rolldown } from "vite"
import { licenseFileText } from "./third-party-notices"

const root = path.resolve(import.meta.dir, "..")

test("the build's notices cover every bundled package and the adapted code", async () => {
  const { output } = (await build({
    root,
    logLevel: "silent",
    build: { write: false },
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

  expect(text).toContain("\n## src/features/comments/anchoring.ts (adapted code)\n")
  expect(text).toContain("Copyright (c) 2013-2019 Hypothes.is Project and contributors")
  expect(text).toContain("2. Redistributions in binary form must reproduce the above copyright notice,")
}, 60_000)
