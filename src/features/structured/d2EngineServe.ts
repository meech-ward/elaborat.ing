/**
 * A D2 engine's worker, however its files load: the app's
 * (d2Engine.worker.ts) fetches them, the chat card's
 * (src/chat-card/diagram/engine.worker.ts) has them inlined. The page
 * (d2EngineClient.ts) sends `init` once, then compile requests, each
 * answered under its id; a compile waits for the engine to start, and every
 * one reports a failure to start.
 */
import type { D2CompileRequest } from './compiler.ts';

export type D2EngineRequest<Init extends object = object> =
  | ({ type: 'init' } & Init)
  | { type: 'compile'; id: number; request: D2CompileRequest };

export type D2EngineReply = { id: number; data: unknown } | { id: number; error: string };

/** Go's runtime for one wasm instance (wasm_exec.js). */
export type D2Go = { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };

/** D2 once its wasm runs. */
export type D2Engine = { compile(request: string): string | Promise<string> };

/** What Go's wasm_exec.js defines, and what D2's wasm defines once it runs. */
export type D2Scope = { Go: new () => D2Go; d2?: D2Engine };

const scope = globalThis as unknown as D2Scope;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs D2's wasm, once ELK and its setup have run: ELK registers its layout
 * algorithms on a timer, so that goes first.
 */
export async function runD2(go: D2Go, instance: WebAssembly.Instance): Promise<D2Engine> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void go.run(instance);
  if (!scope.d2) throw new Error('it did not start');
  return scope.d2;
}

/** Answers the page: `load` starts the engine from what `init` carries. */
export function serveD2Engine<Init extends object>(load: (init: Init) => Promise<D2Engine>): void {
  let engine: Promise<D2Engine> | null = null;

  const start = async (init: Init) => {
    try {
      return await load(init);
    } catch (error) {
      throw new Error(`The diagram engine could not load (${message(error)}).`);
    }
  };

  self.onmessage = async ({ data }: MessageEvent<D2EngineRequest<Init>>) => {
    if (data.type === 'init') {
      engine = start(data as Init);
      // Each compile reports a failure to start.
      engine.catch(() => undefined);
      return;
    }
    const { id, request } = data as Extract<D2EngineRequest, { type: 'compile' }>;
    let reply: D2EngineReply;
    try {
      if (!engine) throw new Error('The diagram engine was not started.');
      const d2 = await engine;
      const response = JSON.parse(await d2.compile(JSON.stringify(request)));
      if (response.error) throw new Error(response.error.message);
      reply = { id, data: response.data };
    } catch (error) {
      reply = { id, error: message(error) };
    }
    self.postMessage(reply);
  };
}
