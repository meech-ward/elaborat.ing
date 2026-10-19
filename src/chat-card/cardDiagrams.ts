/**
 * The diagrams the chat card draws itself: a D2 diagram the app has not
 * drawn from its source yet, because it has no canvas (not_drawn) or its
 * source changed since (stale), for which the server sent what it is drawn
 * from (toolResult.ts `diagrams`). The diagram module, loaded from
 * elaborat.ing the first time (modules.ts), lays it out with the app's D2
 * engine and draws it (diagram/draw.ts). Until then its embed says it is
 * being laid out; one that cannot be drawn (the module or the engine does
 * not load, the host's policy does not allow the engine, or the source does
 * not compile) shows as the server sent it, and the model hears why on its
 * next turn (`onNotDrawn`).
 * Each is drawn once for the card, so the same diagram shown again is drawn
 * at once. A card with no diagram to draw never loads the module. The engine
 * stops once it has had nothing to lay out for a while, for its memory, and
 * starts again for a later diagram (diagram/d2Engine.ts).
 */
import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { Drawn, NotDrawn } from "./diagram/draw"
import { loadModule, ModuleNotLoaded } from "./modules"
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

/** Who tells the model about each diagram the card could not draw. */
const tellers = new Set<(path: string, text: string) => void>()

/**
 * Calls `tell` once for each diagram the card could not draw, with its path
 * and what the model should hear about it, which takes the place of what it
 * heard about that diagram before.
 */
export function onNotDrawn(tell: (path: string, text: string) => void): () => void {
  tellers.add(tell)
  return () => {
    tellers.delete(tell)
  }
}

/** Tells the model why the diagram at `path` could not be drawn. */
function tellNotDrawn(path: string, sent: DiagramSource, { problem, message }: NotDrawn) {
  console.warn(`${path} could not be drawn here.`, message)
  const card = `The elaborat.ing card could not draw the diagram ${path}`
  const sees = sent.canvas === undefined ? "only a link to open it in elaborat.ing" : "it as it was drawn before its source changed"
  const note =
    problem === "source"
      ? `${card}: its D2 source has an error. Fix the source with update_and_show. D2 said: ${message}`
      : problem === "engine"
        ? `${card}: this chat does not let it run D2's engine. The user sees ${sees}. If they want to see it in the chat, offer to make it as an Excalidraw drawing with create_and_show and a .excalidraw path.`
        : `${card}. ${message}`
  for (const tell of tellers) tell(path, note)
}

function draw(path: string, sent: DiagramSource): Promise<void> {
  const key = keyOf(path, sent)
  let drawing = started.get(key)
  if (!drawing) {
    drawing = loadModule("diagram")
      .then((module) => module.drawDiagram(path, sent))
      .catch((error: unknown): Drawn => ({
        problem: error instanceof ModuleNotLoaded ? "engine" : "drawing",
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((drawn) => {
        settled = new Map(settled).set(key, "svg" in drawn ? drawn.svg : null)
        for (const listener of listeners) listener()
        if ("problem" in drawn) tellNotDrawn(path, sent, drawn)
      })
    started.set(key, drawing)
  }
  return drawing
}

/** Draws the file's diagrams; resolves once each is drawn or could not be. */
export function drawDiagrams(file: CardFile): Promise<void> {
  return Promise.all([...toDraw(file)].map(([path, sent]) => draw(path, sent))).then(() => {})
}

/** Starts D2's engine for a diagram on its way, such as a .d2 file being written, or keeps it running while it comes. */
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
