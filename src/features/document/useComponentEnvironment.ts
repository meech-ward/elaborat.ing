import { useEffect, useMemo, useState } from 'react';
import type { ComponentEnvironment } from './componentModules';
import type { ComponentSourceLoader } from './componentSource';

/** The saved revision each imported module had when it was read; null when it could not be read. */
export type ModuleRevisions = ReadonlyMap<string, string | null>;

function cachedSourceLoader(load: ComponentSourceLoader | undefined, generation: string): {loader: ComponentSourceLoader; revisions: ModuleRevisions} | undefined {
  if (!load) return undefined;
  const cache = new Map<string, ReturnType<ComponentSourceLoader>>();
  const revisions = new Map<string, string | null>();
  const loader: ComponentSourceLoader = path => {
    const key = `${generation}\0${path}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(path).then(file => {revisions.set(path,file.revision);return file;},error => {cache.delete(key);revisions.set(path,null);throw error;});
      cache.set(key,pending);
    }
    return pending;
  };
  return {loader,revisions};
}

/**
 * Calls `onChange` once, when a module in `revisions` has a different saved
 * revision (or starts or stops being readable) after a change on the device.
 * Drafts and changes to other files leave saved revisions alone, so they never
 * call it.
 */
export function watchSavedModules(subscribe: (listener: () => void) => () => void, revisions: ModuleRevisions, load: ComponentSourceLoader, onChange: () => void): () => void {
  let stopped = false, checking = false, again = false;
  const check = async () => {
    if (checking) {again = true;return;}
    checking = true;
    try {
      do {
        again = false;
        for (const [path,revision] of [...revisions]) {
          let now: string | null;
          try {now = (await load(path)).revision;} catch {now = null;}
          if (stopped) return;
          if (now !== revision) {stopped = true;onChange();return;}
        }
      } while (again && !stopped);
    } finally {checking = false;}
  };
  const unsubscribe = subscribe(() => void check());
  return () => {stopped = true;unsubscribe();};
}

type ComponentPreparation = { environment?: ComponentEnvironment; error?: string; loader?: ComponentSourceLoader; settled?: boolean; identity?: number };

/** Ordinary typing keeps the last good environment; another document cannot. */
export function componentPreparationForIdentity(state: ComponentPreparation, identity: number, loader?: ComponentSourceLoader): { environment?: ComponentEnvironment; error?: string; pending?: boolean } {
  if (state.identity !== identity) return { pending: true };
  return { environment: state.environment, error: state.error, pending: !state.settled || state.loader !== loader };
}

/** Longer than this, a text could pass 2 MiB (three UTF-8 bytes per UTF-16 unit), which only a compile reports. */
const MAX_PLAIN_TEXT = Math.floor((2 * 1024 * 1024) / 3);

/**
 * Text with nothing a component environment is made from: no brace (MDX
 * expressions, attribute values and spreads all start with one) and no line
 * that could begin an import or export (the first one after a byte order
 * mark too). Anything else may hold code.
 */
export function holdsNoCode(source: string): boolean {
  return source.length <= MAX_PLAIN_TEXT && !source.includes('{') && !/^\uFEFF?[ \t]{0,3}(?:import|export)\b/m.test(source);
}

/**
 * The environment for `source` without compiling it, when the last one
 * compiled for this document (with this loader, and no error) has no custom
 * code or modules and the new text holds no code either: the catalog,
 * modules and code are then the same, and only the source is new. Otherwise
 * null, and the text is compiled. Typing prose in such a note compiles nothing.
 */
export function reusedEnvironment(state: ComponentPreparation, identity: number, loader: ComponentSourceLoader | undefined, source: string): ComponentEnvironment | null {
  const environment = state.environment;
  if (!environment || !state.settled || state.error !== undefined || state.identity !== identity || state.loader !== loader) return null;
  if (environment.modules.length > 0 || environment.code.length > 0 || !holdsNoCode(source)) return null;
  return environment.source === source ? environment : { ...environment, source };
}

// The MDX compiler loads with the first note that needs it.
const componentModules = () => import('./componentModules');
const NO_COMPONENTS = {};

/**
 * Saved dependencies are cached until the explicit note Reload generation, or
 * until one of the modules they came from is saved again, here or by sync.
 */
export function useComponentEnvironment(source: string, enabled: boolean, load?: ComponentSourceLoader, generation = 0, subscribe?: (listener: () => void) => () => void, identity = 0): {environment?: ComponentEnvironment; error?: string; pending?: boolean} {
  const [moduleEpoch,setModuleEpoch] = useState(0);
  // The epoch is part of the cache's semantics, not a dependency-only hint:
  // the React Compiler may otherwise reuse cachedSourceLoader(load) across
  // Reloads even when a surrounding memo lists a discarded `void generation`.
  const cached = useMemo(() => cachedSourceLoader(load,`${identity}:${generation}:${moduleEpoch}`), [load,identity,generation,moduleEpoch]);
  const cachedLoader = cached?.loader;
  const [state,setState] = useState<ComponentPreparation>({});
  // Made in the same render as the text, so the rendered view never waits for it.
  const reused = useMemo(() => enabled ? reusedEnvironment(state,identity,cachedLoader,source) : null, [enabled,state,identity,cachedLoader,source]);
  const compile = enabled && reused === null;
  useEffect(() => {
    if (!compile) return;
    let cancelled = false;
    componentModules().then(({prepareComponentEnvironment}) => prepareComponentEnvironment(source,cachedLoader)).then(environment => {
      if (!cancelled) setState({environment,loader:cachedLoader,settled:true,identity});
    },error => {
      if (!cancelled) setState(previous => ({environment:previous.identity === identity ? previous.environment : undefined,error:error instanceof Error ? error.message : String(error),loader:cachedLoader,settled:true,identity}));
    });
    return () => {cancelled = true;};
  },[source,compile,cachedLoader,identity]);
  useEffect(() => {
    if (!enabled || !load || !subscribe || !cached) return;
    return watchSavedModules(subscribe,cached.revisions,load,() => setModuleEpoch(epoch => epoch + 1));
  },[enabled,load,subscribe,cached]);
  return useMemo(() => {
    if (!enabled) return NO_COMPONENTS;
    return reused ? {environment:reused,pending:false} : componentPreparationForIdentity(state,identity,cachedLoader);
  }, [enabled,reused,state,identity,cachedLoader]);
}
