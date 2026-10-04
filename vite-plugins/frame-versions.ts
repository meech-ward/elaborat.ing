// The note frame's versions on the sandbox domain (docs/architecture.md,
// Frontend hosting). A build writes its frame files to a folder named after
// their contents, `frame/<hash>/` (vite-plugins/preview-frame.ts), and lists
// it in frame/versions.json. A deploy replaces the domain's files, so before
// deploying, scripts/keep-frame-versions.ts copies the last few versions the
// domain serves back in (`keepFrameVersions`): a tab still on an earlier app
// version keeps the frame page it names.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The list of versions in the sandbox folder, newest first. */
export const FRAME_VERSIONS = "frame/versions.json"
/** How many versions the domain serves: this build's and the ones before it. */
export const KEPT_FRAME_VERSIONS = 5

/** A version of the frame's page: its folder (`frame/<hash>/`) and its files' names. */
export type FrameVersion = { folder: string; files: string[] }

/** The folder for a set of frame files: `frame/` and 16 hex digits of their SHA-256. */
export function pageFolder(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`)
  return `frame/${hash.digest("hex").slice(0, 16)}/`
}

export function writeFrameVersions(dir: string, versions: FrameVersion[]): void {
  writeFileSync(path.join(dir, FRAME_VERSIONS), `${JSON.stringify({ versions }, null, 2)}\n`)
}

/** A listed version, if it is one: a hash folder and plain file names, so nothing is written outside its folder. */
function asVersion(value: unknown): FrameVersion | null {
  const { folder, files } = (value ?? {}) as { folder?: unknown; files?: unknown }
  if (typeof folder !== "string" || !/^frame\/[0-9a-f]{16}\/$/.test(folder)) return null
  if (!Array.isArray(files) || !files.includes("index.html")) return null
  if (!files.every((name) => typeof name === "string" && /^[a-z0-9-]+\.(?:html|js)$/.test(name))) return null
  return { folder, files: [...new Set(files as string[])] }
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Copy the versions `origin` serves, newest first, into `dir` after this
 * build's, up to KEPT_FRAME_VERSIONS in all, and list them in
 * frame/versions.json. A version is kept only when every file downloads and
 * their contents hash to its folder's name, since its files are cached as
 * never changing. Returns the folders listed and what was left out, and why;
 * nothing here stops a deploy.
 */
export async function keepFrameVersions(
  dir: string,
  origin: string,
  fetchFile: (url: string) => Promise<Response> = fetch,
): Promise<{ kept: string[]; problems: string[] }> {
  const versions = (JSON.parse(readFileSync(path.join(dir, FRAME_VERSIONS), "utf8")) as { versions: FrameVersion[] }).versions
  const problems: string[] = []
  let live: unknown[] = []
  try {
    const response = await fetchFile(new URL(FRAME_VERSIONS, `${origin}/`).href)
    if (response.status !== 200) throw new Error(`status ${response.status}`)
    const body = (await response.json()) as { versions?: unknown }
    if (!Array.isArray(body.versions)) throw new Error("no list")
    live = body.versions
  } catch (error) {
    problems.push(`The sandbox domain's list of frame versions could not be read (${reason(error)}), so only this build's frame is kept.`)
  }
  for (const entry of live) {
    if (versions.length >= KEPT_FRAME_VERSIONS) break
    const version = asVersion(entry)
    if (!version) {
      problems.push(`Left out ${JSON.stringify(entry)}: not a frame version.`)
      continue
    }
    if (versions.some((kept) => kept.folder === version.folder)) continue
    try {
      const files: Record<string, string> = {}
      await Promise.all(
        version.files.map(async (name) => {
          const response = await fetchFile(new URL(name === "index.html" ? version.folder : `${version.folder}${name}`, `${origin}/`).href)
          if (response.status !== 200) throw new Error(`${name}: status ${response.status}`)
          files[name] = await response.text()
        }),
      )
      if (pageFolder(files) !== version.folder) throw new Error("its files do not match its name")
      mkdirSync(path.join(dir, version.folder), { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, version.folder, name), text)
      versions.push(version)
    } catch (error) {
      problems.push(`Left out ${version.folder} (${reason(error)}).`)
    }
  }
  writeFrameVersions(dir, versions)
  return { kept: versions.map((version) => version.folder), problems }
}
