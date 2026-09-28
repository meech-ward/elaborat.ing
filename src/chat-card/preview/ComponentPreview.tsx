/**
 * The component preview in the chat card: a note with components, or a
 * component file, drawn by the app's own components in a frame nested in
 * the card. The card compiles the sources the server sent (compile.ts),
 * builds the frame's document with the compiled code in it
 * (frameDocument.ts) and shows it in an iframe with sandbox="allow-scripts"
 * only: an opaque origin, so the note's code cannot reach the card's page or
 * its bridge to the host, and cannot call tools. The card then sends it data
 * only (what to show, the server's drawings, props, colours and fonts), and
 * reads back only its height, whether it drew, and a clicked link, which the
 * card offers to open and opens through the host only when the person says so.
 *
 * `onOutcome` hears when the preview has drawn (with the components that
 * threw doing so) or failed; the card shows what it had until then, and
 * again when the preview fails. With `held`, a preview that runs custom code
 * (component files from the project, or a note's own code) is compiled
 * but not run: `onOutcome` hears "asking", with those files, until the card
 * lets it go. A draft the agent sent is not asked about; the saved files it
 * imports are.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { CARD_FONTS } from "../fonts"
import type { CardFile } from "../toolResult"
import { compileComponents, compileErrorMessage, compileNote, type PreviewProgram } from "./compile"
import { frameDocument } from "./frameDocument"
import { linkSpot, readFrameMessage } from "./frameMessages"
import type { CardToFrame, ComponentError, PreviewAppearance, PreviewPlan } from "./protocol"

/** The frame's script and stylesheet (runtime.tsx), which scripts/build-chat-card.ts builds first and sets here. */
declare const PREVIEW_RUNTIME: string
declare const PREVIEW_STYLE: string

/** How long the frame has to draw before the card stops waiting for it. */
const LOAD_TIMEOUT = 15_000
/** The tallest the frame grows. */
const MAX_HEIGHT = 20_000

export type LinkSpot = NonNullable<ReturnType<typeof linkSpot>>

export type PreviewOutcome =
  | { status: "shown"; errors: ComponentError[] }
  | { status: "failed"; message: string }
  | { status: "asking"; files: string[] }

/** `code`: the files whose custom code the preview runs, by path. */
type Prepared = { file: CardFile; run: number; srcdoc: string; plan: PreviewPlan; code: string[] }


/** The card's colours and fonts now, which the frame follows. */
function currentAppearance(): PreviewAppearance {
  const root = document.documentElement
  const scheme = root.dataset.scheme === "dark" || root.dataset.scheme === "light" ? root.dataset.scheme : null
  const variables: Record<string, string> = {}
  for (const name of ["--ui-font", "--heading-font", "--code-font"]) {
    const value = root.style.getPropertyValue(name)
    if (value) variables[name] = value
  }
  const hostFonts = document.querySelector("style[data-host-fonts]")?.textContent || null
  return { scheme, variables, hostFonts }
}

let runs = 0

async function prepare(file: CardFile): Promise<Prepared> {
  const sources = file.components ?? {}
  const program: PreviewProgram =
    file.kind === "component"
      ? await compileComponents(file.path, sources, { component: file.preview?.component ?? null, props: file.preview?.props ?? null })
      : await compileNote(file.source ?? "", sources)
  const run = ++runs
  const modules = program.modules.map((module) => module.path)
  const plan: PreviewPlan =
    program.note !== null
      ? { kind: "note", modules, embeds: file.embeds.filter((embed) => embed !== null), svgs: file.svgs }
      : { kind: "components", modules, target: program.target ?? file.path, items: program.items ?? [] }
  const srcdoc = frameDocument({ runtime: PREVIEW_RUNTIME, style: PREVIEW_STYLE, program, run, scheme: currentAppearance().scheme })
  const draft = file.kind === "component" && file.preview?.draft === true
  const code = [...new Set((program.code ?? []).map((path) => path ?? file.path))].filter((path) => !(draft && path === file.path))
  return { file, run, srcdoc, plan, code }
}

export function ComponentPreview({
  file,
  held = false,
  onOutcome,
  onLink,
}: {
  file: CardFile
  /** Wait for the person before running custom code (from a project shared with them). */
  held?: boolean
  onOutcome: (outcome: PreviewOutcome) => void
  /** A link clicked in the preview, and where to ask about it (linkSpot). */
  onLink: (href: string, spot: LinkSpot | null) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [height, setHeight] = useState(0)
  const shownHeight = useRef(0)
  const outcome = useEffectEvent(onOutcome)
  const link = useEffectEvent(onLink)
  const waiting = held && prepared !== null && prepared.code.length > 0

  // Compiled once for each file the card shows.
  useEffect(() => {
    let stale = false
    prepare(file).then(
      (ready) => {
        if (!stale) setPrepared(ready)
      },
      (error: unknown) => {
        if (!stale) outcome({ status: "failed", message: compileErrorMessage(error) })
      },
    )
    return () => {
      stale = true
    }
  }, [file])

  // The frame's messages, for as long as its document is the one prepared.
  useEffect(() => {
    if (!prepared) return
    if (waiting) return outcome({ status: "asking", files: prepared.code })
    let settled = false
    const settle = (value: PreviewOutcome) => {
      window.clearTimeout(timer)
      // A preview that fails after it drew still fails; nothing else changes an outcome.
      if (settled && value.status !== "failed") return
      settled = true
      outcome(value)
    }
    const send = (message: CardToFrame) => frame.current?.contentWindow?.postMessage(message, "*")
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = readFrameMessage(event.data)
      if (!message || message.run !== prepared.run) return
      switch (message.type) {
        case "ready":
          return send({ type: "setup", plan: prepared.plan, appearance: currentAppearance(), fonts: CARD_FONTS })
        case "size":
          shownHeight.current = Math.min(message.height, MAX_HEIGHT)
          return setHeight(shownHeight.current)
        case "rendered":
          return settle({ status: "shown", errors: message.errors })
        case "failed":
          return settle({ status: "failed", message: message.message })
        case "link":
          return link(message.href, linkSpot(message, shownHeight.current))
      }
    }
    // A chat whose policy does not allow the frame at all.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (/^(frame|child)-src/.test(event.violatedDirective)) settle({ status: "failed", message: "This chat does not allow the preview's frame." })
    }
    const timer = window.setTimeout(() => settle({ status: "failed", message: "The preview did not load." }), LOAD_TIMEOUT)
    const appearance = new MutationObserver(() => send({ type: "appearance", appearance: currentAppearance() }))
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "class", "style"] })
    window.addEventListener("message", onMessage)
    document.addEventListener("securitypolicyviolation", onViolation)
    return () => {
      window.clearTimeout(timer)
      appearance.disconnect()
      window.removeEventListener("message", onMessage)
      document.removeEventListener("securitypolicyviolation", onViolation)
    }
  }, [prepared, waiting])

  if (!prepared || prepared.file !== file || waiting) return null
  return (
    <iframe
      key={prepared.run}
      ref={frame}
      title={`Preview of ${file.path}`}
      sandbox="allow-scripts"
      srcDoc={prepared.srcdoc}
      className="block w-full border-0"
      style={{ height }}
    />
  )
}
