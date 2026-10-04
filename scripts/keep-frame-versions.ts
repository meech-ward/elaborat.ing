// Keeps the last few versions of the note frame's page on the sandbox domain,
// so a tab still on an earlier app version keeps its frame
// (vite-plugins/frame-versions.ts). Run after `bun run build`, before
// deploying wrangler.sandbox.jsonc:
//
//   bun scripts/keep-frame-versions.ts https://<your sandbox domain>
//
// It copies the versions the domain serves now into dist-sandbox/. What it
// cannot copy is left out with a warning, and the deploy goes ahead.
import path from "node:path"
import { keepFrameVersions } from "../vite-plugins/frame-versions.ts"

const origin = process.argv[2]
if (!origin) {
  console.error("Usage: bun scripts/keep-frame-versions.ts https://<your sandbox domain>")
  process.exit(1)
}
const { kept, problems } = await keepFrameVersions(path.join(import.meta.dirname, "..", "dist-sandbox"), origin)
for (const problem of problems) console.warn(process.env.GITHUB_ACTIONS ? `::warning::${problem}` : problem)
console.log(`Frame versions to deploy, newest first:\n${kept.map((folder) => `  ${folder}`).join("\n")}`)
