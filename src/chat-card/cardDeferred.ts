/**
 * The drawings and diagrams that did not fit in show_file's result
 * (`deferred`, fileView.ts MAX_META_CHARS). Where the host lets the card
 * call tools, it loads each with card_embed, the view's own tool, for its
 * path in the same project, one at a time in the note's order, and shows it
 * where its link was, as that result has it: its SVG, or what the card
 * draws a diagram from (cardDiagrams.ts). Both come in the result's
 * structuredContent, since a host may leave `_meta` out of the result of a
 * call the card makes. Until then its embed says it is loading. A call that
 * fails, or that the host has not answered in 20 s, and a host that does not
 * let the card call tools, leave its link. Once the host has not answered
 * one, the rest leave theirs at once, with no more calls. A newer file for
 * the card stops the calls.
 */
import { useEffect, useMemo, useState } from "react"
import type { HostBridge } from "./bridge"
import { parseEmbedResult, type CardEmbed, type CardFile, type LoadedEmbed } from "./toolResult"

/** How long the card waits for one drawing or diagram before it leaves its link. */
const LOAD_TIMEOUT_MS = 20_000

/** Each deferred path's own result, or null where it could not be loaded. */
type Loaded = ReadonlyMap<string, LoadedEmbed | null>

const NONE: Loaded = new Map()

/** The paths of `file`'s deferred embeds, each once, in the note's order. */
const deferredPaths = (file: CardFile): string[] => [...new Set(file.embeds.flatMap((embed) => (embed?.status === "deferred" ? [embed.path] : [])))]

/** What `within` settles to when no answer came in time. */
const NO_ANSWER = Symbol("no answer")

/** What `promise` settles to, or NO_ANSWER once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

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
    if (!got) return embed
    if (got.svg) svgs[embed.path] = got.svg
    if (got.diagram) diagrams[embed.path] = got.diagram
    return { ...embed, status: got.status }
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
      const paths = deferredPaths(file)
      for (const [index, path] of paths.entries()) {
        let answer: unknown = null
        try {
          answer = await within(host.callTool("card_embed", { project_id: file.projectId, path }), LOAD_TIMEOUT_MS)
        } catch {
          // Refused or failed: the link stays.
        }
        if (stopped) return
        // Not answered in time: the host stopped answering, so this link and the rest stay at once, with no more calls.
        const silent = answer === NO_ANSWER
        const got = silent ? null : parseEmbedResult(answer, path)
        setLoaded((current) => {
          const next = new Map(current?.file === file ? current.got : NONE)
          for (const each of silent ? paths.slice(index) : [path]) next.set(each, got)
          return { file, got: next }
        })
        if (silent) return
      }
    })()
    return () => {
      stopped = true
    }
  }, [file, host])
  return useMemo(() => file && withLoaded(file, loaded?.file === file ? loaded.got : NONE, host !== null), [file, loaded, host])
}
