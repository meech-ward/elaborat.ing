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
 */
import { D2EngineClient } from "@/features/structured/d2EngineClient.ts"

/** The engine's two scripts, which scripts/build-chat-card.ts sets. */
declare const CARD_D2_ENGINE: readonly string[]

/** The worker's own script: it imports the engine's. */
const workerUrl = () =>
  URL.createObjectURL(new Blob([`importScripts(${CARD_D2_ENGINE.map((url) => JSON.stringify(url)).join(",")})`], { type: "text/javascript" }))

export class D2 extends D2EngineClient<object> {
  constructor() {
    super(new Worker(workerUrl()), {})
  }
}
