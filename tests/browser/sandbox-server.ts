// The harness's frame page on a second origin, as the sandbox domain serves
// it: worker/sandbox.ts answers every request, with the files the harness
// build wrote to tests/browser/harness/dist-sandbox/ as its assets and the
// harness as the only page that may frame it. Started by playwright.config.ts.
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { handleSandbox } from "../../worker/sandbox.ts"
import { HARNESS_URL, SANDBOX_URL } from "./urls.ts"

const ROOT = path.join(import.meta.dirname, "harness/dist-sandbox")
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8" }

/** Static files, as Cloudflare's assets binding serves them: a folder's index.html at its path. */
const assets = {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    const file = path.join(ROOT, pathname.endsWith("/") ? `${pathname}index.html` : pathname)
    if (!file.startsWith(`${ROOT}${path.sep}`)) return new Response("Not found", { status: 404 })
    try {
      return new Response(await readFile(file), { headers: { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" } })
    } catch {
      return new Response("Not found", { status: 404 })
    }
  },
}

const { hostname, port } = new URL(SANDBOX_URL)
createServer(async (incoming, outgoing) => {
  const request = new Request(new URL(incoming.url ?? "/", SANDBOX_URL), { method: incoming.method })
  const response = await handleSandbox(request, { ASSETS: assets, FRAME_ANCESTORS: new URL(HARNESS_URL).origin })
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}).listen(Number(port), hostname)
