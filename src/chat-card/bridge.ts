/**
 * The chat card's side of the MCP Apps bridge: JSON-RPC 2.0 over postMessage
 * with the host (Claude, ChatGPT) that frames the card. It sends
 * ui/initialize, answers the host's pings, passes the tool's input and result
 * on to the card, follows the host's theme, safe area and display mode (and
 * its fonts, in ChatGPT), reports the card's size, and proxies tool calls,
 * links, display mode requests and model context through the host. ChatGPT
 * also offers window.openai.callTool and requestDisplayMode, and hands the
 * result's `_meta` to window.openai.
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */
import { z } from "zod/mini"

/** The spec version this view speaks. */
export const PROTOCOL_VERSION = "2026-01-26"

/** What the host tells the card, in the order it happens. */
export type HostEvent =
  | { type: "tool-input"; args: unknown }
  | { type: "tool-result"; result: unknown }
  | { type: "tool-cancelled" }
  /**
   * Initialized: whether the host lets the card call this server's tools, the
   * origins it approved for scripts and other resources, or null when it did
   * not say (`hostCapabilities.sandbox.csp.resourceDomains`), and whether the
   * card uses the host's fonts instead of the app's (ChatGPT, whose
   * guidelines ask for the system's fonts).
   */
  | { type: "ready"; canCallTools: boolean; resourceDomains: string[] | null; hostFonts: boolean }
  /** ChatGPT set its globals, which may hold a result's `_meta` that came late. */
  | { type: "globals" }

export type HostBridge = {
  /** Receives every event; events from before the first subscriber wait for it. Returns an unsubscribe. */
  subscribe(listener: (event: HostEvent) => void): () => void
  /** Calls one of this server's tools through the host. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Opens an http(s) or mailto link, resolved against `base`, through the host. */
  openLink(href: string, base: string): void
  /** Gives the model context for its next turn, without starting one. */
  tellModel(text: string): void
  /** Whether the host can show the card full screen. */
  canFullscreen(): boolean
  /** Asks the host to show the card inline or full screen; the host may say no. */
  requestDisplayMode(mode: DisplayMode): void
  /** The result `_meta` ChatGPT hands the card on window.openai, or undefined. */
  openaiMeta(): unknown
}

export type DisplayMode = "inline" | "fullscreen"

/** The display modes the card offers the host (`appCapabilities.availableDisplayModes`). */
export const DISPLAY_MODES: readonly DisplayMode[] = ["inline", "fullscreen"]

type OpenAiGlobals = {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<unknown>
  toolResponseMetadata?: unknown
}

declare global {
  interface Window {
    openai?: OpenAiGlobals
  }
}

const capabilitiesSchema = z.catch(
  z.object({
    serverTools: z.optional(z.unknown()),
    openLinks: z.optional(z.unknown()),
    sandbox: z.catch(z.optional(z.object({ csp: z.catch(z.optional(z.object({ resourceDomains: z.optional(z.catch(z.array(z.string()), [])) })), undefined) })), undefined),
  }),
  {},
)

const insetsSchema = z.partial(z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }))

/** The parts of the host context the card uses; anything else is ignored. */
const contextSchema = z.catch(
  z.object({
    theme: z.catch(z.optional(z.enum(["light", "dark"])), undefined),
    displayMode: z.catch(z.optional(z.string()), undefined),
    availableDisplayModes: z.catch(z.optional(z.array(z.string())), undefined),
    safeAreaInsets: z.catch(z.optional(insetsSchema), undefined),
    styles: z.catch(
      z.optional(
        z.object({
          variables: z.catch(z.optional(z.record(z.string(), z.optional(z.string()))), undefined),
          css: z.catch(z.optional(z.object({ fonts: z.optional(z.string()) })), undefined),
        }),
      ),
      undefined,
    ),
  }),
  {},
)

type HostContext = z.infer<typeof contextSchema>

const messageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.optional(z.union([z.string(), z.number()])),
  method: z.optional(z.string()),
  params: z.optional(z.unknown()),
  result: z.optional(z.unknown()),
  error: z.optional(z.unknown()),
})

const argumentsSchema = z.catch(z.object({ arguments: z.unknown() }), { arguments: undefined })

/** The system's fonts, which stand in for the app's where the card uses the host's fonts and the host names none. */
const SYSTEM_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const SYSTEM_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/** ChatGPT, which puts window.openai in the frames it shows or names itself so. */
function isChatGpt(hostName: unknown): boolean {
  return typeof window.openai === "object" || (typeof hostName === "string" && /chatgpt|openai/i.test(hostName))
}

/** The fonts the card uses in place of the app's: the host's where it names them, else the system's. */
function applyHostFonts(context: HostContext) {
  const root = document.documentElement
  const variables = context.styles?.variables
  const sans = variables?.["--font-sans"] || SYSTEM_SANS
  root.style.setProperty("--ui-font", sans)
  root.style.setProperty("--heading-font", sans)
  root.style.setProperty("--heading-tracking", "normal")
  root.style.setProperty("--code-font", variables?.["--font-mono"] || SYSTEM_MONO)
  const fonts = context.styles?.css?.fonts
  if (fonts) {
    let style = document.querySelector<HTMLStyleElement>("style[data-host-fonts]")
    if (!style) {
      style = document.createElement("style")
      style.dataset.hostFonts = ""
      document.head.append(style)
    }
    style.textContent = fonts
  }
}

/**
 * Follows the host's theme, safe area and display mode. The colours stay the
 * app's own palette in the host's light or dark. The fonts stay the app's,
 * except with `hostFonts` (ChatGPT).
 */
function applyContext(context: HostContext, hostFonts: boolean) {
  const root = document.documentElement
  if (context.theme) {
    root.dataset.scheme = context.theme
    root.classList.toggle("dark", context.theme === "dark")
  }
  if (context.displayMode) root.dataset.displayMode = context.displayMode
  const insets = context.safeAreaInsets
  if (insets) {
    document.body.style.padding = [insets.top, insets.right, insets.bottom, insets.left].map((value) => `${value ?? 0}px`).join(" ")
  }
  if (hostFonts) applyHostFonts(context)
}

/** Tells the host the card's size whenever it changes. */
function watchSize(notify: (method: string, params: Record<string, unknown>) => void) {
  const root = document.documentElement
  let last = ""
  let scheduled = false
  const send = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const before = root.style.height
      root.style.height = "max-content"
      const height = Math.ceil(root.getBoundingClientRect().height)
      root.style.height = before
      const width = Math.ceil(window.innerWidth)
      if (`${width}x${height}` === last) return
      last = `${width}x${height}`
      notify("ui/notifications/size-changed", { width, height })
    })
  }
  send()
  const observer = new ResizeObserver(send)
  observer.observe(root)
  observer.observe(document.body)
}

/** Connects to the host that frames this page and sends ui/initialize. One per page. */
export function connectHost(appVersion: string): HostBridge {
  const pending = new Map<string | number, { resolve(value: unknown): void; reject(reason: unknown): void }>()
  const waiting: HostEvent[] = []
  const listeners = new Set<(event: HostEvent) => void>()
  let nextId = 1
  let capabilities: z.infer<typeof capabilitiesSchema> = {}
  let hostFonts = isChatGpt(undefined)
  let hostModes: string[] = []
  const follow = (raw: unknown) => {
    const context = contextSchema.parse(raw)
    if (context.availableDisplayModes) hostModes = context.availableDisplayModes
    applyContext(context, hostFonts)
  }

  const post = (message: Record<string, unknown>) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*")
  const notify = (method: string, params: Record<string, unknown> = {}) => post({ method, params })
  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++
    post({ id, method, params })
    return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const emit = (event: HostEvent) => {
    if (listeners.size === 0) waiting.push(event)
    for (const listener of listeners) listener(event)
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const parsed = messageSchema.safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data
    if (message.method === undefined) {
      const answer = message.id === undefined ? undefined : pending.get(message.id)
      if (!answer || message.id === undefined) return
      pending.delete(message.id)
      if (message.error) answer.reject(message.error)
      else answer.resolve(message.result)
      return
    }
    switch (message.method) {
      case "ui/notifications/tool-input":
        return emit({ type: "tool-input", args: argumentsSchema.parse(message.params ?? {}).arguments })
      case "ui/notifications/tool-result":
        return emit({ type: "tool-result", result: message.params })
      case "ui/notifications/tool-cancelled":
        return emit({ type: "tool-cancelled" })
      case "ui/notifications/host-context-changed":
        return follow(message.params)
    }
    if (message.id === undefined) return
    if (message.method === "ping" || message.method === "ui/resource-teardown") post({ id: message.id, result: {} })
    else post({ id: message.id, error: { code: -32601, message: "Method not found" } })
  })

  // ChatGPT may set its globals after the result arrived without _meta.
  window.addEventListener("openai:set_globals", () => emit({ type: "globals" }))

  const openai = () => window.openai
  const canCallTools = () => !!capabilities.serverTools || typeof openai()?.callTool === "function"

  request("ui/initialize", {
    appInfo: { name: "elaborat.ing file view", version: appVersion },
    appCapabilities: { availableDisplayModes: DISPLAY_MODES },
    protocolVersion: PROTOCOL_VERSION,
  }).then(
    (raw) => {
      const result = z
        .catch(z.partial(z.object({ hostCapabilities: z.unknown(), hostContext: z.unknown(), hostInfo: z.catch(z.object({ name: z.unknown() }), { name: undefined }) })), {})
        .parse(raw ?? {})
      capabilities = capabilitiesSchema.parse(result.hostCapabilities ?? {})
      hostFonts = isChatGpt(result.hostInfo?.name)
      follow(result.hostContext)
      notify("ui/notifications/initialized")
      watchSize(notify)
      const csp = capabilities.sandbox?.csp
      emit({ type: "ready", canCallTools: canCallTools(), resourceDomains: csp ? (csp.resourceDomains ?? []) : null, hostFonts })
    },
    () => {},
  )

  return {
    subscribe(listener) {
      listeners.add(listener)
      for (const event of waiting.splice(0)) listener(event)
      return () => listeners.delete(listener)
    },
    callTool(name, args) {
      const globals = openai()
      if (capabilities.serverTools || typeof globals?.callTool !== "function") return request("tools/call", { name, arguments: args })
      return globals.callTool(name, args)
    },
    openLink(href, base) {
      let url: URL
      try {
        url = new URL(href, base)
      } catch {
        return
      }
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return
      const fallback = () => window.open(url.href, "_blank", "noopener")
      if (capabilities.openLinks) request("ui/open-link", { url: url.href }).catch(fallback)
      else fallback()
    },
    tellModel(text) {
      request("ui/update-model-context", { content: [{ type: "text", text }] }).catch(() => {})
    },
    canFullscreen: () => hostModes.includes("fullscreen") || typeof openai()?.requestDisplayMode === "function",
    requestDisplayMode(mode) {
      if (hostModes.includes(mode)) request("ui/request-display-mode", { mode }).catch(() => {})
      else openai()?.requestDisplayMode?.({ mode })?.catch(() => {})
    },
    openaiMeta: () => openai()?.toolResponseMetadata,
  }
}
