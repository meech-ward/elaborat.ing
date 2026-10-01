// Writes the ZIP to upload to OpenAI's plugin portal (docs/submission.md):
//
//   bun run package:plugin   writes dist-plugin/elaborating-<version>.zip and lists what is in it
//
// The ZIP holds plugins/elaborating with plugin.json at its root. Claude
// Code's manifest (.claude-plugin/) stays out: the portal reads the root
// plugin.json. It refuses, and writes nothing, when the folder has something
// the portal rejects: app references (`apps`, .app.json), lifecycle hooks,
// reviewer credentials or instructions (`test_credentials`,
// `reviewer_instructions`, which go in the dashboard), hidden files, or a
// listing path to a file that is not there.
// https://developers.openai.com/plugins/deploy/submission#automatically-provide-submission-and-review-information
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { zipSync } from "fflate"

const ROOT = path.join(import.meta.dirname, "..")
const PLUGIN = path.join(ROOT, "plugins", "elaborating")
const OUT = path.join(ROOT, "dist-plugin")
const LEFT_OUT = new Set([".claude-plugin"])

/** Every file under `dir`, as `/`-separated paths relative to the plugin, sorted. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !LEFT_OUT.has(path.relative(PLUGIN, path.join(dir, entry.name))))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? filesIn(full) : [path.relative(PLUGIN, full).split(path.sep).join("/")]
    })
    .sort()
}

/** Every key in a JSON value, at any depth. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn)
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => [key, ...keysIn(inner)])
  return []
}

const files = filesIn(PLUGIN)
const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "plugin.json"), "utf8"))
const openai = manifest.extensions?.["com.openai"] ?? {}
const problems: string[] = []

for (const file of files) {
  const name = file.split("/").at(-1)!
  if (file.split("/").some((part) => part.startsWith("."))) problems.push(`${file}: hidden files are not uploaded`)
  if (name === ".app.json" || file.split("/")[0] === "apps") problems.push(`${file}: app references cannot be submitted`)
  if (file.split("/")[0] === "hooks") problems.push(`${file}: lifecycle hooks cannot be submitted`)
  if (/test_credentials|reviewer_instructions/.test(file)) problems.push(`${file}: reviewer access goes in the dashboard, not the ZIP`)
  if (name.endsWith(".json")) {
    const keys = keysIn(JSON.parse(readFileSync(path.join(PLUGIN, file), "utf8")))
    for (const key of ["test_credentials", "reviewer_instructions"]) {
      if (keys.includes(key)) problems.push(`${file}: "${key}" goes in the dashboard, not the ZIP`)
    }
  }
}
if ("apps" in openai || "apps" in manifest) problems.push('plugin.json: "apps" (app references) cannot be submitted')
if ("hooks" in openai || "hooks" in manifest) problems.push('plugin.json: "hooks" (lifecycle hooks) cannot be submitted')

const listed = [openai.interface?.logo, openai.interface?.composerIcon, ...(openai.interface?.screenshots ?? []), openai.onboardingSkill]
for (const ref of listed.filter((ref): ref is string => typeof ref === "string")) {
  if (!files.includes(ref.replace(/^\.\//, ""))) problems.push(`plugin.json: ${ref} is not in the plugin`)
}

if (problems.length > 0) {
  console.error(`Not packaged. The portal rejects:\n${problems.map((problem) => `  ${problem}`).join("\n")}`)
  process.exit(1)
}

// A fixed date, so the same files make the same ZIP.
const zip = zipSync(Object.fromEntries(files.map((file) => [file, readFileSync(path.join(PLUGIN, file))])), {
  level: 9,
  mtime: new Date("2026-01-01T00:00:00Z"),
})
mkdirSync(OUT, { recursive: true })
const out = path.join(OUT, `${manifest.name}-${manifest.version}.zip`)
writeFileSync(out, zip)
console.log(`${path.relative(ROOT, out)} (${(statSync(out).size / 1024).toFixed(1)} kB)`)
for (const file of files) console.log(`  ${file}`)
