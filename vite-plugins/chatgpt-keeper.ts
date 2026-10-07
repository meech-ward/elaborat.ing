import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { loadEnv, type Plugin, type ViteDevServer } from "vite"
import { keeperHandler, PlanKeeper, type CredentialStore, type Credentials } from "../supabase/functions/_shared/chatgpt/keeper.ts"
import { MAX_REQUEST_BYTES } from "../supabase/functions/_shared/chatgpt/responses.ts"

/**
 * The local token keeper for ChatGPT plan usage (docs/architecture.md,
 * "The assistant"): in `vite` (the dev server) only, and only with
 * VITE_CHATGPT_PLAN set. It serves /chatgpt/{start,status,responses,disconnect}
 * and /auth/callback on http://127.0.0.1:<port>, the loopback redirect
 * OpenAI's open-source flow takes, and keeps the tokens in a file outside
 * the repository, so the browser never holds one.
 */
const LIVE_VIEW_PACKAGES = ["roughjs", "rehype-sanitize", "rehype-stringify", "remark-frontmatter", "remark-gfm", "remark-parse", "remark-rehype", "unified"]

export function chatgptKeeper(): Plugin {
  let enabled = false
  return {
    name: "chatgpt-keeper",
    apply: "serve",
    config(config, env) {
      const vars = loadEnv(env.mode, config.envDir || config.root || process.cwd(), "VITE_")
      enabled = Boolean(vars.VITE_CHATGPT_PLAN)
      if (!enabled) return
      return {
        // The sign-in comes back to 127.0.0.1 exactly (not localhost), so the dev server listens there.
        ...(config.server?.host === undefined ? { server: { host: "127.0.0.1" } } : {}),
        // The live view's renderers (supabase/functions/mcp-server/tools) import
        // their packages as Deno does, which the dependency scan does not
        // follow: without these, the first write would make the dev server
        // bundle them then and reload the page.
        optimizeDeps: { include: LIVE_VIEW_PACKAGES },
      }
    },
    configureServer(server) {
      if (!enabled) return
      const keeper = new PlanKeeper({ store: fileCredentialStore(credentialPath()) })
      const handle = keeperHandler(keeper, { origin: () => originOf(server) })
      server.httpServer?.once("listening", () => {
        if (!isLoopbackAddress(server.httpServer?.address())) server.config.logger.warn(`ChatGPT keeper is off: the dev server is not bound to 127.0.0.1. ${OPEN_TO_OTHERS}`)
      })
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0]
        if (!pathname.startsWith("/chatgpt/") && pathname !== "/auth/callback") return next()
        // The Origin check in the handler is a header any program can send,
        // so the keeper only answers this computer, at 127.0.0.1:<port>.
        const origin = originOf(server)
        if (!isLoopbackAddress(server.httpServer?.address())) return refuse(res, OPEN_TO_OTHERS)
        if (!isLoopbackRequest(req, origin)) return refuse(res, `Open elaborat.ing at ${origin} on this computer to use your ChatGPT plan.`)
        void serve(req, res, handle, origin).catch((error: unknown) => {
          if (!res.headersSent) res.statusCode = 500
          res.end()
          server.config.logger.error(`ChatGPT keeper: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    },
  }
}

/**
 * VITE_CHATGPT_PLAN as a constant in every build: its value, or "" when it
 * is unset (Vite leaves an unset variable to a lookup at run time). The
 * places that show the assistant test it, so a build without it, such as
 * the hosted site's, leaves the assistant out entirely.
 */
export function chatgptPlanFlag(): Plugin {
  return {
    name: "chatgpt-plan-flag",
    config(config, env) {
      const vars = loadEnv(env.mode, config.envDir || config.root || process.cwd(), "VITE_")
      return { define: { "import.meta.env.VITE_CHATGPT_PLAN": JSON.stringify(vars.VITE_CHATGPT_PLAN ?? "") } }
    },
  }
}

/** Where the credentials live: $XDG_CONFIG_HOME/elaborating/chatgpt.json, or ~/.config/elaborating/chatgpt.json. */
export function credentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "elaborating", "chatgpt.json")
}

/** The credentials in one file, readable by its owner only (0600, in a 0700 folder), written whole each time. */
export function fileCredentialStore(file: string): CredentialStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Credentials
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async write(credentials) {
      const dir = path.dirname(file)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, file)
    },
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const OPEN_TO_OTHERS = "Start the dev server without --host to use your ChatGPT plan."

/** Whether the dev server listens on this computer only (not with --host, which opens it to other devices). */
export function isLoopbackAddress(address: AddressInfo | string | null | undefined): boolean {
  return typeof address === "object" && address !== null && LOOPBACK.has(address.address)
}

/** Whether a request comes from this computer, addressed to the keeper's own 127.0.0.1:<port>. */
export function isLoopbackRequest(req: Pick<IncomingMessage, "socket" | "headers">, origin: string): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && req.headers.host === new URL(origin).host
}

function refuse(res: ServerResponse, message: string) {
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "error", message }))
}

function originOf(server: ViteDevServer): string {
  const address = server.httpServer?.address()
  const port = address && typeof address === "object" ? address.port : (server.config.server.port ?? 5173)
  return `http://127.0.0.1:${port}`
}

async function serve(req: IncomingMessage, res: ServerResponse, handle: (request: Request) => Promise<Response | null>, origin: string) {
  const method = req.method ?? "GET"
  const chunks: Buffer[] = []
  let size = 0
  if (method !== "GET" && method !== "HEAD") {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "error", message: "This chat is too long. Start a new chat." }))
        return
      }
      chunks.push(chunk)
    }
  }
  // Stop asks the browser to abort; the request to OpenAI stops with it.
  const abort = new AbortController()
  res.on("close", () => abort.abort())
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  const request = new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    signal: abort.signal,
  })
  const response = await handle(request)
  if (!response) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // The browser went away (Stop): the stream to OpenAI is aborted above.
  } finally {
    res.end()
  }
}
