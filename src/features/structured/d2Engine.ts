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
import { D2EngineClient } from './d2EngineClient.ts';
import type { D2EngineInit } from './d2Engine.worker.ts';

export class D2 extends D2EngineClient<D2EngineInit> {
  constructor() {
    super(new Worker(new URL('./d2Engine.worker.ts', import.meta.url), { type: 'module' }), {
      wasmUrl: new URL(wasmUrl, location.href).href,
      elkUrl: new URL(elkUrl, location.href).href,
      wasmExec,
      setup,
    });
  }
}
