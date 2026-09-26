import { useEffect, useMemo, useState } from 'react';
import { prepareComponentEnvironment, type ComponentEnvironment, type ComponentSourceLoader } from './componentModules';

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

/**
 * Saved dependencies are cached until the explicit note Reload generation, or
 * until one of the modules they came from is saved again, here or by sync.
 */
export function useComponentEnvironment(source: string, enabled: boolean, load?: ComponentSourceLoader, generation = 0, subscribe?: (listener: () => void) => () => void): {environment?: ComponentEnvironment; error?: string; pending?: boolean} {
  const [moduleEpoch,setModuleEpoch] = useState(0);
  // The epoch is part of the cache's semantics, not a dependency-only hint:
  // the React Compiler may otherwise reuse cachedSourceLoader(load) across
  // Reloads even when a surrounding memo lists a discarded `void generation`.
  const cached = useMemo(() => cachedSourceLoader(load,`${generation}:${moduleEpoch}`), [load,generation,moduleEpoch]);
  const cachedLoader = cached?.loader;
  const [state,setState] = useState<{environment?:ComponentEnvironment;error?:string;loader?:typeof cachedLoader;settled?:boolean}>({});
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    prepareComponentEnvironment(source,cachedLoader).then(environment => {
      if (!cancelled) setState({environment,loader:cachedLoader,settled:true});
    },error => {
      if (!cancelled) setState(previous => ({environment:previous.environment,error:error instanceof Error ? error.message : String(error),loader:cachedLoader,settled:true}));
    });
    return () => {cancelled = true;};
  },[source,enabled,cachedLoader]);
  useEffect(() => {
    if (!enabled || !load || !subscribe || !cached) return;
    return watchSavedModules(subscribe,cached.revisions,load,() => setModuleEpoch(epoch => epoch + 1));
  },[enabled,load,subscribe,cached]);
  return enabled ? {...state,pending:!state.settled || state.loader !== cachedLoader} : {};
}
