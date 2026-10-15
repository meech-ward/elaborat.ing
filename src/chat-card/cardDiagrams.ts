/**
 * The diagrams the chat card draws itself: a D2 diagram the app has not
 * drawn from its source yet, because it has no canvas (not_drawn) or its
 * source changed since (stale), for which the server sent what it is drawn
 * from (toolResult.ts `diagrams`). The diagram module, loaded from
 * elaborat.ing the first time (modules.ts), lays it out with the app's D2
 * engine and draws it (diagram/draw.ts). Until then its embed says it is
 * being laid out; one that cannot be drawn (the module or the engine does
 * not load, the host's policy does not allow the engine, or the source does
 * not compile) shows as the server sent it.
 * Each is drawn once for the card, so the same diagram shown again is drawn
 * at once. A card with no diagram to draw never loads the module.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { loadModule } from "./modules"
import type { CardEmbed, CardFile, DiagramSource } from "./toolResult"

const DRAWN_HERE = new Set(["not_drawn", "stale"])

/** The diagrams in `file` the card draws, by path. */
function toDraw(file: CardFile): Map<string, DiagramSource> {
  const found = new Map<string, DiagramSource>()
  for (const embed of file.embeds) {
    if (!embed || embed.kind !== "diagram" || !DRAWN_HERE.has(embed.status)) continue
    const sent = file.diagrams[embed.path]
    if (sent) found.set(embed.path, sent)
  }
  return found
}

/** Whether `file` has a diagram the card draws itself. */
export const hasDiagramsToDraw = (file: CardFile): boolean => toDraw(file).size > 0

const keyOf = (path: string, { source, canvas, layout }: DiagramSource) => JSON.stringify([path, source, canvas ?? null, layout ?? null])

/** Each drawing started, and those that have settled: the SVG, or null where it could not be drawn. */
const started = new Map<string, Promise<void>>()
let settled: ReadonlyMap<string, string | null> = new Map()
const listeners = new Set<() => void>()

function draw(path: string, sent: DiagramSource): Promise<void> {
  const key = keyOf(path, sent)
  let drawing = started.get(key)
  if (!drawing) {
    drawing = loadModule("diagram")
      .then((module) => module.drawDiagram(path, sent))
      .then(
        (svg) => svg,
        (error: unknown) => {
          console.warn(`${path} could not be drawn here.`, error)
          return null
        },
      )
      .then((svg) => {
        settled = new Map(settled).set(key, svg)
        for (const listener of listeners) listener()
      })
    started.set(key, drawing)
  }
  return drawing
}

/** Draws the file's diagrams; resolves once each is drawn or could not be. */
export function drawDiagrams(file: CardFile): Promise<void> {
  return Promise.all([...toDraw(file)].map(([path, sent]) => draw(path, sent))).then(() => {})
}

/** Starts D2's engine for a diagram on its way, such as a .d2 file being written. */
export function startDiagramEngine(): void {
  loadModule("diagram").then(
    (module) => module.startEngine(),
    () => {},
  )
}

/**
 * `file` as the card shows it: each diagram it draws shown as drawn once it
 * is, as being laid out until then, and as the server sent it where it
 * could not be drawn. The same file when it has none.
 */
function withDrawings(file: CardFile, drawings: ReadonlyMap<string, string | null>): CardFile {
  const wanted = toDraw(file)
  if (wanted.size === 0) return file
  const svgs = { ...file.svgs }
  const embeds = file.embeds.map((embed): CardEmbed | null => {
    const sent = embed ? wanted.get(embed.path) : undefined
    if (!embed || !sent) return embed
    const svg = drawings.get(keyOf(embed.path, sent))
    if (svg === undefined) return { ...embed, status: "drawing" }
    if (svg === null) return embed
    svgs[embed.path] = svg
    return { ...embed, status: "drawn" }
  })
  return { ...file, embeds, svgs }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = () => settled

/** `file` with the diagrams the card draws, which it starts drawing; each shows once it settles. */
export function useDrawnFile(file: CardFile | null): CardFile | null {
  const drawings = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (file) void drawDiagrams(file)
  }, [file])
  return useMemo(() => file && withDrawings(file, drawings), [file, drawings])
}
