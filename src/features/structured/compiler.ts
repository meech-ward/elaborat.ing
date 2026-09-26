/*!
 * D2 diagram layout by @terrastruct/d2 (https://github.com/terrastruct/d2),
 * used unmodified from npm under the Mozilla Public License 2.0
 * (https://mozilla.org/MPL/2.0/). Source for the version pinned in
 * package.json: https://github.com/terrastruct/d2/tree/master/d2js/js
 *
 * Its browser build embeds the ELK layout engine, elkjs
 * (https://github.com/kieler/elkjs), Copyright (c) 2017 Kiel University and
 * others, under the Eclipse Public License 2.0
 * (https://www.eclipse.org/legal/epl-2.0/). SPDX-License-Identifier: EPL-2.0
 */
/**
 * Async compiler seam: D2 source -> native scene + baseline + diagnostics.
 *
 * The real layout always comes from `@terrastruct/d2` (MPL-2.0, a runtime
 * dependency pinned in package.json). There is
 * deliberately no fallback parser: without the package the compile fails
 * with a `d2/unavailable` diagnostic instead of inventing geometry.
 *
 * A source syntax error never destroys work: the result carries `ok: false`
 * and the prior scene/baseline unchanged, plus a `d2/syntax` diagnostic.
 */
import { emitNativeScene } from './emitter.ts';
import { mergeRegeneration, recordForElement } from './merge.ts';
import { hashSource } from './sourceHash.ts';
import nativeFont from './native-font.json';
export { hashSource } from './sourceHash.ts';
import type {
  CompileOptions,
  CompileResult,
  D2Diagram,
  Diagnostic,
  GeneratedBaseline,
  NativeScene,
} from './types.ts';

/**
 * Minimal port the compiler needs. Tests inject stubs; prod injects D2.
 * Real ports also carry `dispose`, which terminates the underlying worker.
 */
export type D2CompilePort = ((input: {
  source: string;
  virtualFiles?: Record<string, string>;
}) => Promise<D2Diagram>) & {
  dispose?: () => Promise<void>;
};

export type CompilerPorts = {
  d2?: D2CompilePort;
};

function baselineForScene(source: string, scene: NativeScene): GeneratedBaseline {
  const elements: GeneratedBaseline['elements'] = {};
  for (const el of scene.elements) {
    if (el.id.startsWith('d2:')) elements[el.id] = recordForElement(el);
  }
  return { language: 'd2', sourceHash: hashSource(source), elements };
}

function missingPackageError(): Error {
  return new Error(
    'Missing dependency "@terrastruct/d2". Install the version pinned in package.json.',
  );
}

export type D2CompileRequest = {
  fs: Record<string, string>;
  inputPath?: string;
  options?: { layout?: 'dagre' | 'elk'; fontRegular?: string; fontBold?: string; fontItalic?: string; fontSemibold?: string };
};

// One portable font for D2 measurement and native family 5 rendering. The
// emitter supports regular text, so style variants deliberately measure regular.
// D2 0.1.33's worker JSON.stringify boundary requires Go []byte's base64 JSON
// representation. Its declared Uint8Array becomes an object and is rejected.
const nativeFontBase64 = nativeFont.ttfBase64;

type D2Instance = {
  compile: (input: string | D2CompileRequest) => Promise<{ diagram: D2Diagram }>;
  /**
   * The underlying worker handle. Present in the published node and
   * browser builds (`this.worker`); absent on stubs. Terminated by
   * {@link disposeSharedD2} so tests and short-lived processes exit.
   */
  worker?: { terminate(): unknown };
};

type D2Module = {
  D2: new () => D2Instance;
};

/**
 * Build the official virtual-FS compile request: the entry source lives at
 * `index.d2`, imports (`...@path` lines anywhere in the source) resolve
 * against the supplied map only. Verified live against 0.1.33; a missing
 * import throws a structured D2 error, never a filesystem or network read.
 */
export function buildCompileRequest(source: string, virtualFiles: Record<string, string> = {}): D2CompileRequest {
  if ('index.d2' in virtualFiles) {
    throw new Error(
      'Conflicting virtual file "index.d2": the entry source occupies that path. Rename the import.',
    );
  }
  return { fs: { ...virtualFiles, 'index.d2': source }, inputPath: 'index.d2', options: {
    layout: 'elk', fontRegular: nativeFontBase64, fontBold: nativeFontBase64,
    fontItalic: nativeFontBase64, fontSemibold: nativeFontBase64,
  } };
}

async function loadD2Module(): Promise<D2Module> {
  try {
    return (await import('@terrastruct/d2')) as D2Module;
  } catch {
    throw missingPackageError();
  }
}

/**
 * Process-wide D2 instance. Each `new D2()` spawns a worker thread that
 * loads the ~22MB WASM engine and keeps the event loop alive until it is
 * terminated, so compiling through a fresh instance per call leaks one
 * immortal worker per compile. All real ports share this singleton:
 * at most one worker per process.
 */
let sharedD2: D2Instance | null = null;
let sharedD2Ready: Promise<D2Instance> | null = null;

export async function getSharedD2(): Promise<D2Instance> {
  if (sharedD2) return sharedD2;
  if (!sharedD2Ready) {
    sharedD2Ready = (async () => {
      const mod = await loadD2Module();
      sharedD2 = new mod.D2();
      return sharedD2;
    })();
  }
  return sharedD2Ready;
}

/**
 * Terminate the shared D2 worker and forget the instance, so the next
 * compile starts a fresh one. Live tests call this in `afterAll`
 * (otherwise the worker keeps the test process alive); the app keeps the
 * singleton for the page/session lifetime and never calls it per compile.
 * Safe to call when no instance exists or the package is absent.
 */
export async function disposeSharedD2(): Promise<void> {
  const instance = sharedD2;
  sharedD2 = null;
  sharedD2Ready = null;
  try {
    await instance?.worker?.terminate();
  } catch {
    // The worker is already gone; nothing to release.
  }
}

/**
 * Test seam: replace the shared D2 instance with a stub. `null` forgets
 * the instance so the next compile loads the real module again.
 */
export function setSharedD2ForTest(instance: D2Instance | null): void {
  sharedD2 = instance;
  sharedD2Ready = instance ? Promise.resolve(instance) : null;
}

/**
 * Serialized compile queue for the shared instance. The published 0.1.33
 * node-esm `sendMessage` overwrites `currentResolve/currentReject` per
 * request with no request IDs, so overlapping `compile` calls on one
 * instance resolve the wrong caller (or never). Every real compile runs
 * inside this queue: at most one `d2.compile` is in flight, concurrent
 * callers each receive their own result, and a rejection releases the
 * queue for the next compile. The tail never rejects, so one failure
 * cannot wedge later compiles.
 */
let compileQueue: Promise<unknown> = Promise.resolve();

function enqueueD2Compile<T>(task: () => Promise<T>): Promise<T> {
  const run = compileQueue.then(() => task());
  compileQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Default port: calls the real D2 WASM compiler with the official
 * virtual-FS request form through the shared instance. All IO is bounded
 * to `virtualFiles`. The port carries `dispose` (= {@link disposeSharedD2})
 * for tests and short-lived hosts; per-compile construction is cheap and
 * never spawns a worker by itself.
 */
export function createD2CompilePort(): D2CompilePort {
  const run = async ({
    source,
    virtualFiles,
  }: {
    source: string;
    virtualFiles?: Record<string, string>;
  }): Promise<D2Diagram> => {
    return enqueueD2Compile(async () => {
      const d2 = await getSharedD2();
      const result = await d2.compile(buildCompileRequest(source, virtualFiles ?? {}));
      if (!result || typeof result !== 'object' || !('diagram' in result)) {
        throw new Error('Unexpected @terrastruct/d2 response: missing result.diagram.');
      }
      return (result as { diagram: D2Diagram }).diagram;
    });
  };
  const port: D2CompilePort = run;
  port.dispose = disposeSharedD2;
  return port;
}

let defaultPort: D2CompilePort | null = null;

/**
 * The process-wide default port. `compileStructured` uses this when the
 * caller injects no port, so repeated compiles reuse the one shared worker
 * instead of allocating a port (and previously an instance) per call.
 */
export function getDefaultD2Port(): D2CompilePort {
  if (!defaultPort) defaultPort = createD2CompilePort();
  return defaultPort;
}

/**
 * Compile D2 in the browser through the shared worker, returning the raw
 * diagram or the compiler's message. The D2 package (an 8 MB chunk with its
 * WASM inlined) loads on the first call.
 */
export async function compileD2Diagram(
  source: string,
): Promise<{ ok: true; diagram: D2Diagram } | { ok: false; error: string }> {
  try {
    return { ok: true, diagram: await getDefaultD2Port()({ source }) };
  } catch (error) {
    return { ok: false, error: syntaxMessage(error) };
  }
}

function syntaxMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function compileStructured(
  source: string,
  options: CompileOptions = {},
  ports: CompilerPorts = {},
): Promise<CompileResult> {
  const language = options.language ?? 'd2';
  if (language !== 'd2') {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: 'structured/unsupported-language',
      message: `Unsupported structured language "${language}". Only "d2" is implemented; Mermaid is explicitly out of scope.`,
    };
    return {
      ok: false,
      language: 'd2',
      scene: options.prior?.scene ?? { elements: [] },
      baseline: options.prior?.baseline ?? null,
      diagnostics: [diagnostic],
      conflicts: [],
    };
  }

  const port = ports.d2 ?? getDefaultD2Port();
  let diagram: D2Diagram;
  try {
    diagram = await port({ source, virtualFiles: options.virtualFiles });
  } catch (error) {
    const message = syntaxMessage(error);
    const unavailable = message.includes('Missing dependency "@terrastruct/d2"');
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: unavailable ? 'd2/unavailable' : 'd2/syntax',
      message: unavailable ? message : `D2 syntax error: ${message}`,
    };
    // Preserve the prior scene: a broken edit never deletes saved work.
    return {
      ok: false,
      language,
      scene: options.prior?.scene ?? { elements: [] },
      baseline: options.prior?.baseline ?? null,
      diagnostics: [diagnostic],
      conflicts: [],
    };
  }

  const emitted = emitNativeScene(diagram);
  const freshScene: NativeScene = { elements: emitted.elements };
  const freshBaseline = baselineForScene(source, freshScene);

  if (!options.prior) {
    return {
      ok: true,
      language,
      scene: freshScene,
      baseline: freshBaseline,
      diagnostics: emitted.diagnostics,
      conflicts: [],
    };
  }
  const merged = mergeRegeneration({
    baseline: options.prior.baseline,
    currentScene: options.prior.scene,
    freshScene,
    freshBaseline,
  });
  return {
    ok: true,
    language,
    scene: merged.scene,
    baseline: merged.baseline,
    diagnostics: [...emitted.diagnostics, ...merged.diagnostics],
    conflicts: merged.conflicts,
  };
}
