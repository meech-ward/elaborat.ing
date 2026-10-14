// The chat card's builds in public/chat-card (scripts/build-chat-card.ts),
// which every app deploy serves at https://elaborat.ing/chat-card/. The
// view's HTML names one build's files, and a host may still hold the HTML of
// an earlier build: hosts cache it (ChatGPT for up to about an hour), and the
// Edge Functions deploy apart from the app. So a build's files stay through
// the next several builds: the folder keeps the newest KEPT_CARD_BUILDS,
// listed newest first in builds.json. Files are named by their contents, so
// one that several builds share, like a font, is stored once.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The list of builds in the folder, `{ builds }`: each build's file names, newest first. */
export const CARD_BUILDS = "builds.json"
/** How many builds the folder keeps: the newest, which the view names, and the ones before it. */
export const KEPT_CARD_BUILDS = 10

/** The builds a builds.json lists, newest first. One written before builds were counted lists `current` and `previous`. */
export function listedCardBuilds(json: unknown): string[][] {
  const { builds, current, previous } = (json ?? {}) as { builds?: unknown; current?: unknown; previous?: unknown }
  return (Array.isArray(builds) ? builds : [current, previous]).filter((files): files is string[] => Array.isArray(files) && files.length > 0)
}

/**
 * Write a build's files into `dir` and list the build first in builds.json,
 * before the builds `committed` lists (the builds.json last committed),
 * KEPT_CARD_BUILDS in all. The committed builds are what the last deploy
 * serves, so builds between commits replace each other, not them, and a build
 * the same as the newest committed one changes nothing. A kept file missing
 * from `dir` comes back with `restore`, which reads it from the last commit;
 * every other file in `dir` is removed. Returns the builds listed.
 */
export function keepCardBuilds(
  dir: string,
  files: ReadonlyMap<string, string | Uint8Array>,
  committed: string[][],
  restore?: (name: string) => Uint8Array,
): string[][] {
  const build = [...files.keys()].sort()
  const same = (other: string[]) => [...other].sort().join() === build.join()
  const builds = committed.length > 0 && same(committed[0]) ? committed : [build, ...committed.filter((other) => !same(other))].slice(0, KEPT_CARD_BUILDS)
  const kept = new Set(builds.flat())
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) if (name !== CARD_BUILDS && !kept.has(name)) rmSync(path.join(dir, name))
  for (const name of kept) if (restore && !files.has(name) && !existsSync(path.join(dir, name))) writeFileSync(path.join(dir, name), restore(name))
  for (const [name, text] of files) writeFileSync(path.join(dir, name), text)
  writeFileSync(path.join(dir, CARD_BUILDS), `${JSON.stringify({ builds }, null, 2)}\n`)
  return builds
}
