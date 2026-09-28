/**
 * D2 in the app: what `import('@terrastruct/d2')` loads in the browser build
 * (vite-plugins/d2-engine.ts), with the one call the compiler uses. The
 * engine runs in a worker (d2Engine.worker.ts) from the package's own files:
 * its wasm is a file of its own, compiled while it downloads, and cached for
 * offline use like the rest of the build.
 */
import wasmUrl from 'd2-engine:d2.wasm?url';
import elkUrl from 'd2-engine:elk.js?url';
import wasmExec from 'd2-engine:wasm_exec.js?raw';
import setup from 'd2-engine:setup.js?raw';
import type { D2CompileRequest } from './compiler.ts';
import type { D2Diagram } from './types.ts';
import type { D2EngineReply, D2EngineRequest } from './d2Engine.worker.ts';

type Pending = { resolve: (data: { diagram: D2Diagram }) => void; reject: (error: Error) => void };

export class D2 {
  readonly worker = new Worker(new URL('./d2Engine.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped: Error | null = null;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<D2EngineReply>) => {
      const request = this.pending.get(data.id);
      this.pending.delete(data.id);
      if ('error' in data) request?.reject(new Error(data.error));
      else request?.resolve(data.data as { diagram: D2Diagram });
    };
    // The worker's own file did not load, or it stopped.
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.stopped = new Error(event.message || 'The diagram engine stopped.');
      for (const request of this.pending.values()) request.reject(this.stopped);
      this.pending.clear();
    };
    this.post({ type: 'init', wasmUrl: new URL(wasmUrl, location.href).href, elkUrl: new URL(elkUrl, location.href).href, wasmExec, setup });
  }

  compile(request: D2CompileRequest): Promise<{ diagram: D2Diagram }> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'compile', id, request });
    });
  }

  private post(message: D2EngineRequest): void {
    this.worker.postMessage(message);
  }
}
