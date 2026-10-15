/**
 * The D2 engine's worker (see d2Engine.ts). The page sends where the engine's
 * files are and the text of its two small scripts, then compile requests,
 * each answered under its id (d2EngineServe.ts). It starts the engine the way
 * the package's own worker does, with one difference: the wasm compiles while
 * it downloads (when its server labels it application/wasm, as streaming
 * needs).
 */
import { runD2, serveD2Engine, type D2Scope } from './d2EngineServe.ts';

/** What the page sends to start the engine: where its files are, and the text of its two small scripts. */
export type D2EngineInit = { wasmUrl: string; elkUrl: string; wasmExec: string; setup: string };

const scope = globalThis as unknown as D2Scope;

/** Runs one of the engine's scripts in the worker's global scope, as the package does. */
const run = (script: string) => new Function(script).call(globalThis);

async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

/** Compiles the wasm as it downloads; a server that labels it otherwise gets the whole file compiled at once. */
async function instantiate(url: string, imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type === 'application/wasm') return (await WebAssembly.instantiateStreaming(response, imports)).instance;
  return (await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance;
}

serveD2Engine<D2EngineInit>(async ({ wasmUrl, elkUrl, wasmExec, setup }) => {
  run(wasmExec);
  const go = new scope.Go();
  // ELK runs before the engine starts: D2 lays diagrams out with it.
  const layout = text(elkUrl).then((elk) => {
    run(elk);
    run(setup);
  });
  const [, instance] = await Promise.all([layout, instantiate(wasmUrl, go.importObject)]);
  return runD2(go, instance);
});
