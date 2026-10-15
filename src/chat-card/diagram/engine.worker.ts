/**
 * The chat card's D2 engine worker (see d2Engine.ts): a classic script that
 * runs after D2's own files, which `bun run build:chat-card` puts in the
 * engine's other script: Go's wasm_exec.js, ELK and its setup, run as the
 * package runs them, and D2's wasm, brotli-compressed as base64
 * (`d2Wasm`). It unpacks and compiles the wasm here, off the card's page,
 * and answers as the app's worker does (d2EngineServe.ts).
 */
import decompress from "brotli/decompress"
import { runD2, serveD2Engine, type D2Scope } from "@/features/structured/d2EngineServe.ts"

/** D2's wasm, as the engine's script sets it: its size, and its bytes brotli-compressed, as base64. */
type PackedWasm = { size: number; brotli: string }

const scope = globalThis as unknown as D2Scope & { d2Wasm?: PackedWasm }

function bytesOf(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
  return bytes
}

serveD2Engine(async () => {
  const packed = scope.d2Wasm
  if (!packed) throw new Error("its wasm did not load")
  delete scope.d2Wasm
  const go = new scope.Go()
  const wasm = decompress(bytesOf(packed.brotli), packed.size)
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject)
  return runD2(go, instance)
})
