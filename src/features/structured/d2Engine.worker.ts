/**
 * The D2 engine's worker (see d2Engine.ts). The page sends where the engine's
 * files are and the text of its two small scripts, then compile requests,
 * each answered under its id. It starts the engine the way the package's own
 * worker does, with one difference: the wasm compiles while it downloads.
 */
import type { D2CompileRequest } from './compiler.ts';

export type D2EngineRequest =
  | { type: 'init'; wasmUrl: string; elkUrl: string; wasmExec: string; setup: string }
  | { type: 'compile'; id: number; request: D2CompileRequest };

export type D2EngineReply = { id: number; data: unknown } | { id: number; error: string };

/** What Go's wasm_exec.js defines, and what D2's wasm defines once it runs. */
type Scope = {
  Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
  d2?: { compile(request: string): string | Promise<string> };
};

const scope = globalThis as unknown as Scope;

/** Runs one of the engine's scripts in the worker's global scope, as the package does. */
const run = (script: string) => new Function(script).call(globalThis);

async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function load({ wasmUrl, elkUrl, wasmExec, setup }: Extract<D2EngineRequest, { type: 'init' }>) {
  run(wasmExec);
  const go = new scope.Go();
  // ELK runs before the engine starts: D2 lays diagrams out with it.
  const layout = text(elkUrl).then((elk) => {
    run(elk);
    run(setup);
  });
  const [, { instance }] = await Promise.all([layout, WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject)]);
  // ELK registers its layout algorithms on a timer; let it run first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  void go.run(instance);
  if (!scope.d2) throw new Error('it did not start');
  return scope.d2;
}

async function start(init: Extract<D2EngineRequest, { type: 'init' }>) {
  try {
    return await load(init);
  } catch (error) {
    throw new Error(`The diagram engine could not load (${message(error)}).`);
  }
}

let engine: ReturnType<typeof start> | null = null;

self.onmessage = async ({ data }: MessageEvent<D2EngineRequest>) => {
  if (data.type === 'init') {
    engine = start(data);
    // Each compile reports a failure to start.
    engine.catch(() => undefined);
    return;
  }
  let reply: D2EngineReply;
  try {
    if (!engine) throw new Error('The diagram engine was not started.');
    const d2 = await engine;
    const response = JSON.parse(await d2.compile(JSON.stringify(data.request)));
    if (response.error) throw new Error(response.error.message);
    reply = { id: data.id, data: response.data };
  } catch (error) {
    reply = { id: data.id, error: message(error) };
  }
  self.postMessage(reply);
};
