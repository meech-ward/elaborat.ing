import { useEffect, useMemo, useState } from 'react';
import { prepareComponentEnvironment, type ComponentEnvironment, type ComponentSourceLoader } from './componentModules';

function cachedSourceLoader(load: ComponentSourceLoader | undefined, generation: number): ComponentSourceLoader | undefined {
  if (!load) return undefined;
  const cache = new Map<string, ReturnType<ComponentSourceLoader>>();
  return path => {
    const key = `${generation}\0${path}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(path).catch(error => {cache.delete(key);throw error;});
      cache.set(key,pending);
    }
    return pending;
  };
}

/** Saved dependencies are cached only until the explicit note Reload generation. */
export function useComponentEnvironment(source: string, enabled: boolean, load?: ComponentSourceLoader, generation = 0): {environment?: ComponentEnvironment; error?: string; pending?: boolean} {
  // The epoch is part of the cache's semantics, not a dependency-only hint:
  // the React Compiler may otherwise reuse cachedSourceLoader(load) across
  // Reloads even when a surrounding memo lists a discarded `void generation`.
  const cachedLoader = useMemo(() => cachedSourceLoader(load,generation), [load,generation]);
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
  return enabled ? {...state,pending:!state.settled || state.loader !== cachedLoader} : {};
}
