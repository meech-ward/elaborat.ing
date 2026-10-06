/**
 * The component preview's frame: the page the chat card builds for each
 * preview (frameDocument.ts) and shows in an iframe with
 * sandbox="allow-scripts" and nothing else, inside the card's own frame.
 * That is an opaque origin: code here cannot reach the card's page, its
 * bridge to the host (tool calls, links, model context), storage or cookies,
 * and the policy the frame inherits from the card allows no requests but
 * scripts, styles and fonts from elaborat.ing.
 *
 * `bun run build:chat-card` builds this file as an ES module (and
 * runtime.css as a stylesheet) into public/chat-card, served from
 * elaborat.ing; each frame document imports it (frameDocument.ts) and calls
 * `open()` with the registry its inline scripts filled with the compiled
 * component files and note. When the card sends setup, the frame runs them in
 * order with the app's JSX runtime, its trusted React exports and its
 * built-in components (catalog.tsx), and renders the note, or the components
 * with their sample props. A note with a chart loads the charts' library
 * first, from the same place; without it, charts show as a box. A component
 * that throws shows an error in its place (the compiler wraps each outermost
 * element in the guard); anything else that fails is reported to the card,
 * which falls back to what it showed before.
 */
import "./runtime.css"
import { Component, useEffect, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import * as jsxRuntime from "react/jsx-runtime"
import { Banner } from "@/features/design-system/ui/Banner"
import { EmbedBox } from "@/features/design-system/ui/EmbedBox"
import { trustedReact } from "@/preview/trustedReact"
import { CardNote, EmbedFigure, READING_CLASS } from "../cardNote"
import type { CardEmbed } from "../embedText"
import { addFonts } from "../fontFaces"
import { componentCaption } from "./caption"
import { PREVIEW_COMPONENTS } from "./catalog"
import { GUARD_NAME, type CardToFrame, type ComponentError, type FrameToCard, type PreviewAppearance, type PreviewPlan } from "./protocol"

type ModuleScope = Record<string, unknown>
/** A compiled file's function body, wrapped by frameDocument.ts: it takes the runtime and returns the file's exports. */
type ModuleBody = (runtime: Record<string, unknown>) => Promise<Record<string, unknown>>

/** What the frame document's inline scripts fill in (frameDocument.ts). */
type Registry = { run: number; modules: Array<ModuleBody | undefined>; note: ModuleBody | null }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

let run = 0
const post = (message: FrameToCard) => window.parent.postMessage(message, "*")

/** Errors the guards caught before the first report to the card. */
const caught: ComponentError[] = []
let reported = false

/**
 * An error boundary around one element of the note (or one previewed
 * component): an element that throws shows its error instead, and the rest
 * of the preview carries on.
 */
class Guard extends Component<{ name: string; inline?: boolean; children?: ReactNode }, { error: { message: string } | null }> {
  state: { error: { message: string } | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: { message: messageOf(error) } }
  }

  componentDidCatch(error: unknown) {
    if (!reported && caught.length < 20) caught.push({ name: this.props.name, message: messageOf(error) })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const text = `${this.props.name} could not be shown: ${error.message}`
    if (this.props.inline) {
      return (
        <span role="alert" data-preview-error="" className="not-prose rounded-sm bg-[color-mix(in_oklab,var(--danger)_10%,var(--panel))] px-1 text-destructive">
          {text}
        </span>
      )
    }
    return (
      <Banner tone="danger" data-preview-error="" className="not-prose">
        {text}
      </Banner>
    )
  }
}

/** Whatever the whole preview throws: reported to the card, which shows what it had instead. */
class Root extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    post({ type: "failed", run, message: messageOf(error) })
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Tells the card, once, that the preview has drawn, with what the guards caught while it did. */
function Drawn() {
  useEffect(() => {
    if (reported) return
    reported = true
    post({ type: "rendered", run, errors: caught.splice(0) })
  }, [])
  return null
}

function applyAppearance({ scheme, variables, hostFonts }: PreviewAppearance) {
  const root = document.documentElement
  if (scheme) {
    root.dataset.scheme = scheme
    root.classList.toggle("dark", scheme === "dark")
  }
  for (const name of ["--ui-font", "--heading-font", "--code-font"]) {
    const value = variables[name]
    if (value) root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  }
  let style = document.querySelector<HTMLStyleElement>("style[data-host-fonts]")
  if (hostFonts) {
    if (!style) {
      style = document.createElement("style")
      style.dataset.hostFonts = ""
      document.head.append(style)
    }
    style.textContent = hostFonts
  } else {
    style?.remove()
  }
}

/** Reports the preview's height whenever it changes. */
function watchSize(element: HTMLElement) {
  let last = -1
  const send = () => {
    const height = Math.ceil(element.getBoundingClientRect().height)
    if (height === last) return
    last = height
    post({ type: "size", run, height })
  }
  new ResizeObserver(send).observe(element)
  send()
}

/** Links open through the card, which asks the host; a link inside the page just scrolls. */
function watchLinks() {
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null
      if (!link) return
      const href = link.getAttribute("href") ?? ""
      if (href.startsWith("#")) return
      event.preventDefault()
      // Where it is, so the card can ask about it beside it.
      const box = link.getBoundingClientRect()
      post({ type: "link", run, href, top: box.top, bottom: box.bottom })
    },
    true,
  )
}

/** A drawing or diagram the note embeds, drawn from the server's picture as the card draws it. */
function Embed({ kind, src, plan }: { kind: "drawing" | "diagram"; src?: unknown; plan: Extract<PreviewPlan, { kind: "note" }> }) {
  const path = typeof src === "string" ? src : ""
  const embed: CardEmbed = plan.embeds.find((entry) => entry.path === path) ?? { kind, path, url: null, status: "not_shown" }
  return <EmbedFigure embed={embed} svgs={plan.svgs} />
}

/** Runs the compiled files in order, each with the ones it imports. */
async function runModules(plan: PreviewPlan, registry: Registry): Promise<ModuleScope> {
  const workspaceModules: ModuleScope = Object.create(null)
  for (const [index, path] of plan.modules.entries()) {
    const body = registry.modules[index]
    if (!body) throw new Error(`${path} could not be loaded.`)
    try {
      workspaceModules[path] = await body({ ...jsxRuntime, workspaceModules, trustedReact })
    } catch (error) {
      throw new Error(`${path}: ${messageOf(error)}`)
    }
  }
  return workspaceModules
}

/** The charts' components (the app's, on Recharts), or null where they did not load: the boxes stay. */
const loadCharts = () =>
  import("@/features/rendered/documentCharts").then(
    (charts): Record<string, unknown> => charts.DOCUMENT_CHART_COMPONENTS,
    () => null,
  )

async function start(plan: PreviewPlan, registry: Registry) {
  const mount = document.getElementById("root")!
  watchSize(mount)
  watchLinks()
  const root = createRoot(mount)
  const charts = plan.kind === "note" && plan.charts ? loadCharts() : null
  const workspaceModules = await runModules(plan, registry)
  if (plan.kind === "note") {
    if (!registry.note) throw new Error("The note could not be loaded.")
    const exports = await registry.note({ ...jsxRuntime, workspaceModules, trustedReact })
    const Content = exports.default as (props: { components: Record<string, unknown> }) => ReactNode
    const components = {
      ...PREVIEW_COMPONENTS,
      ...(await charts),
      [GUARD_NAME]: Guard,
      Drawing: (props: { src?: unknown }) => <Embed kind="drawing" src={props.src} plan={plan} />,
      Diagram: (props: { src?: unknown }) => <Embed kind="diagram" src={props.src} plan={plan} />,
    }
    root.render(
      <Root>
        <CardNote>
          <div className={READING_CLASS}>
            <Content components={components} />
          </div>
        </CardNote>
        <Drawn />
      </Root>,
    )
    return
  }
  const file = (workspaceModules[plan.target] ?? {}) as Record<string, unknown>
  root.render(
    <Root>
      <div className="flex flex-col gap-4 p-4 max-[500px]:p-3">
        {plan.items.map(({ name, props }, index) => {
          const Shown = file[name] as ((props: Record<string, unknown>) => ReactNode) | undefined
          return (
            <EmbedBox
              key={index}
              data-component-preview={name}
              caption={<code className="min-w-0 wrap-anywhere">{componentCaption(name, props)}</code>}
              className="min-h-[120px] items-stretch"
            >
              <div className="min-w-0 text-[15px] leading-[1.55] text-body">
                <Guard name={name}>{typeof Shown === "function" ? <Shown {...props} /> : <MissingExport name={name} />}</Guard>
              </div>
            </EmbedBox>
          )
        })}
      </div>
      <Drawn />
    </Root>,
  )
}

function MissingExport({ name }: { name: string }): ReactNode {
  throw new Error(`${name} is not a component.`)
}

/**
 * Called by the frame document once this module has loaded, with the
 * registry its scripts fill in. Waits for the whole document (every
 * compiled file registered), tells the card it is ready, and waits for the
 * card's setup.
 */
export function open(registry: Registry) {
  run = registry.run
  let started = false
  window.addEventListener("message", (event: MessageEvent<CardToFrame>) => {
    if (event.source !== window.parent || typeof event.data !== "object" || event.data === null) return
    const message = event.data
    if (message.type === "appearance") return applyAppearance(message.appearance)
    if (message.type !== "setup" || started) return
    started = true
    applyAppearance(message.appearance)
    addFonts(message.fonts)
    start(message.plan, registry).catch((error: unknown) => post({ type: "failed", run, message: messageOf(error) }))
  })
  const ready = () => post({ type: "ready", run })
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true })
  else ready()
}
