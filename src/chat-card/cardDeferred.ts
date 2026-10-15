/**
 * The drawings and diagrams that did not fit in show_file's result
 * (`deferred`, fileView.ts MAX_META_CHARS). Where the host lets the card
 * call tools, it loads each with show_file for its path in the same project,
 * one at a time in the note's order, and shows it where its link was, as
 * that result has it: its SVG, or what the card draws a diagram from
 * (cardDiagrams.ts). Until then its embed says it is loading. A call that
 * fails, and a host that does not let the card call tools, leave its link. A
 * newer file for the card stops the calls.
 */
import { useEffect, useMemo, useState } from "react"
import type { HostBridge } from "./bridge"
import { parseShowResult, type CardEmbed, type CardFile } from "./toolResult"

/** Each deferred path's own result, or null where it could not be loaded. */
type Loaded = ReadonlyMap<string, CardFile | null>

const NONE: Loaded = new Map()

/** The paths of `file`'s deferred embeds, each once, in the note's order. */
const deferredPaths = (file: CardFile): string[] => [...new Set(file.embeds.flatMap((embed) => (embed?.status === "deferred" ? [embed.path] : [])))]

/**
 * `file` with each deferred embed as its own result shows it, once loaded,
 * and until then as loading where the card loads it. The same file when it
 * has none.
 */
function withLoaded(file: CardFile, loaded: Loaded, loading: boolean): CardFile {
  if (!file.embeds.some((embed) => embed?.status === "deferred")) return file
  const svgs = { ...file.svgs }
  const diagrams = { ...file.diagrams }
  const embeds = file.embeds.map((embed): CardEmbed | null => {
    if (embed?.status !== "deferred") return embed
    const got = loaded.get(embed.path)
    if (got === undefined) return loading ? { ...embed, status: "loading" } : embed
    const own = got?.embeds.find((entry) => entry?.path === embed.path)
    if (!got || !own) return embed
    const svg = got.svgs[embed.path]
    if (svg) svgs[embed.path] = svg
    const sent = got.diagrams[embed.path]
    if (sent) diagrams[embed.path] = sent
    return { ...embed, status: own.status }
  })
  return { ...file, embeds, svgs, diagrams }
}

/** `file` with its deferred drawings and diagrams loaded through `host`: null where the card cannot call tools. */
export function useLoadedFile(file: CardFile | null, host: HostBridge | null): CardFile | null {
  const [loaded, setLoaded] = useState<{ file: CardFile; got: Loaded } | null>(null)
  useEffect(() => {
    if (!file || !host) return
    let stopped = false
    void (async () => {
      for (const path of deferredPaths(file)) {
        let got: CardFile | null = null
        try {
          // Its own result's _meta only: ChatGPT's globals hold the note's.
          const shown = parseShowResult(await host.callTool("show_file", { project_id: file.projectId, path }))
          if (shown.ok) got = shown.file
        } catch {
          // Refused or failed: the link stays.
        }
        if (stopped) return
        setLoaded((current) => ({ file, got: new Map(current?.file === file ? current.got : NONE).set(path, got) }))
      }
    })()
    return () => {
      stopped = true
    }
  }, [file, host])
  return useMemo(() => file && withLoaded(file, loaded?.file === file ? loaded.got : NONE, host !== null), [file, loaded, host])
}
