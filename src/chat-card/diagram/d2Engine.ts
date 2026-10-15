/**
 * D2 in the chat card: what `import('@terrastruct/d2')` loads in the card's
 * build (scripts/build-chat-card.ts), as d2Engine.ts is in the app's
 * (src/features/structured). The card's policy lets it make no requests and
 * run no code from strings, so the engine comes as two classic scripts from
 * elaborat.ing, the origin the view declares for scripts, which a worker of
 * the card's own (a blob: URL) imports: D2's files, with its wasm
 * brotli-compressed as base64, and the worker's code (engine.worker.ts),
 * which unpacks and compiles the wasm off the card's page. D2's wasm lays a
 * diagram out by running ELK's JavaScript from strings, so the host's policy
 * must allow blob: workers, WebAssembly and code from strings, as ChatGPT's
 * does; where it does not, the worker or the engine stops, and every compile
 * fails.
 *
 * While its worker runs, the engine holds about 165 MB of the page's memory,
 * and a phone's host can kill a page that takes too much, with no warning the
 * card could catch. So once the engine has had nothing to lay out for
 * IDLE_MS, the card stops its worker, and starts it again for the next
 * diagram, which then waits for the engine to load (about 1.8 s instead of
 * 0.2 s, measured in WebKit as an iPhone).
 */
import type { D2CompileRequest } from "@/features/structured/compiler.ts"
import { D2EngineClient } from "@/features/structured/d2EngineClient.ts"
import type { D2Diagram } from "@/features/structured/types.ts"

/** The engine's two scripts, which scripts/build-chat-card.ts sets. */
declare const CARD_D2_ENGINE: readonly string[]

/** How long the engine's worker runs once it has nothing left to lay out. */
const IDLE_MS = 10_000

/** The worker's own script, which imports the engine's: one blob: URL, for each time the worker starts. */
let workerScript: string | undefined
const workerUrl = () =>
  (workerScript ??= URL.createObjectURL(
    new Blob([`importScripts(${CARD_D2_ENGINE.map((url) => JSON.stringify(url)).join(",")})`], { type: "text/javascript" }),
  ))

export class D2 {
  /** The engine, while its worker runs. */
  private engine: D2EngineClient<object> | null = null
  /** The compiles not answered yet. */
  private laying = 0
  private idle = 0

  constructor() {
    this.start()
  }

  /** Starts the engine's worker if it is stopped. It runs for IDLE_MS from now, and for as long as it lays a diagram out. */
  start(): D2EngineClient<object> {
    this.engine ??= new D2EngineClient(new Worker(workerUrl()), {})
    this.rest()
    return this.engine
  }

  async compile(request: D2CompileRequest): Promise<{ diagram: D2Diagram }> {
    this.laying++
    try {
      return await this.start().compile(request)
    } finally {
      this.laying--
      this.rest()
    }
  }

  /** Stops the worker IDLE_MS from now, unless a compile comes first. */
  private rest() {
    window.clearTimeout(this.idle)
    if (this.laying > 0) return
    this.idle = window.setTimeout(() => {
      this.engine?.worker.terminate()
      this.engine = null
    }, IDLE_MS)
  }
}
