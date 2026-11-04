import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 * revision (or starts or stops being readable), first when watching resumes
 * and then after changes on the device. Drafts and changes to other files
 * leave saved revisions alone, so they never call it.
 */
export function watchSavedModules(subscribe: (listener: () => void) => () => void, revisions: ModuleRevisions, load: ComponentSourceLoader, onChange: () => void): () => void {
  let stopped = false, checking = false, again = false;
  const check = async () => {
    if (stopped) return;
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
  // Hidden notes unsubscribe. A dependency may have been saved meanwhile,
  // so resuming must validate cached revisions without waiting for an event.
  void check();
  return () => {stopped = true;unsubscribe();};
}

type ComponentPreparation = { environment?: ComponentEnvironment; error?: string; loader?: ComponentSourceLoader; settled?: boolean; identity?: number; source?: string };

type SourceCatalog = {identity:number;loader?:ComponentSourceLoader;sequence:number;catalog:ComponentEnvironment['catalog']};
type CatalogScope = {identity:number;loader?:ComponentSourceLoader;live:boolean};

/** Completion metadata may finish after Source has become incomplete. It
 * never carries executable modules or replaces the current preparation. */
export function retainSourceCatalog(previous: SourceCatalog | null, result: SourceCatalog, scope: CatalogScope): SourceCatalog | null {
  if (!scope.live || result.identity !== scope.identity || result.loader !== scope.loader || previous && previous.sequence > result.sequence) return previous;
  return result;
}

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
/** How long typing pauses before a text its own view already shows is compiled. */
export const SHOWN_TEXT_PAUSE_MS = 500;

/**
 * Saved dependencies are cached until the explicit note Reload generation, or
 * until one of the modules they came from is saved again, here or by sync.
 *
 * `shown` says the view that changed the text already shows it, with the
 * last environment: a rendered edit, which that view projected itself. The
 * text's environment is then compiled once typing pauses, not at each
 * keystroke, and the last one stays meanwhile, not pending. Any other text,
 * or one without an environment for this document yet, compiles at once.
 */
export function useComponentEnvironment(source: string, enabled: boolean, load?: ComponentSourceLoader, generation = 0, subscribe?: (listener: () => void) => () => void, identity = 0, shown = false): {environment?: ComponentEnvironment; catalog?:ComponentEnvironment['catalog']; error?: string; pending?: boolean} {
  const [moduleEpoch,setModuleEpoch] = useState(0);
  // The epoch is part of the cache's semantics, not a dependency-only hint:
  // the React Compiler may otherwise reuse cachedSourceLoader(load) across
  // Reloads even when a surrounding memo lists a discarded `void generation`.
  const cached = useMemo(() => cachedSourceLoader(load,`${identity}:${generation}:${moduleEpoch}`), [load,identity,generation,moduleEpoch]);
  const cachedLoader = cached?.loader;
  const [state,setState] = useState<ComponentPreparation>({});
  const [sourceCatalog,setSourceCatalog] = useState<SourceCatalog | null>(null);
  const catalogSequence = useRef(0);
  const catalogScope = useRef<CatalogScope>({identity,loader:cachedLoader,live:true});
  useLayoutEffect(() => {
    catalogScope.current = {identity,loader:cachedLoader,live:true};
    return () => {catalogScope.current.live = false;};
  },[identity,cachedLoader]);
  // Made in the same render as the text, so the rendered view never waits for it.
  const reused = useMemo(() => enabled ? reusedEnvironment(state,identity,cachedLoader,source) : null, [enabled,state,identity,cachedLoader,source]);
  // The last environment compiled for this document and loader, without an error.
  const last = state.settled && state.error === undefined && state.identity === identity && state.loader === cachedLoader ? state.environment : undefined;
  const compile = enabled && reused === null && last?.source !== source;
  const pause = compile && shown && last !== undefined;
  useEffect(() => {
    if (!compile) return;
    let cancelled = false;
    const sequence = ++catalogSequence.current;
    const run = () => componentModules().then(({prepareComponentEnvironment}) => prepareComponentEnvironment(source,cachedLoader)).then(environment => {
      const scope = catalogScope.current;
      const result = {identity,loader:cachedLoader,sequence,catalog:environment.catalog};
      if (scope.live && scope.identity === identity && scope.loader === cachedLoader)
        setSourceCatalog(previous => retainSourceCatalog(previous,result,scope));
      if (!cancelled) setState({environment,loader:cachedLoader,settled:true,identity,source});
    },error => {
      if (!cancelled) setState(previous => ({environment:previous.identity === identity ? previous.environment : undefined,error:error instanceof Error ? error.message : String(error),loader:cachedLoader,settled:true,identity,source}));
    });
    const timer = pause ? window.setTimeout(run, SHOWN_TEXT_PAUSE_MS) : 0;
    if (!pause) void run();
    return () => {cancelled = true;window.clearTimeout(timer);};
  },[source,compile,pause,cachedLoader,identity]);
  useEffect(() => {
    if (!enabled || !load || !subscribe || !cached) return;
    return watchSavedModules(subscribe,cached.revisions,load,() => setModuleEpoch(epoch => epoch + 1));
  },[enabled,load,subscribe,cached]);
  return useMemo(() => {
    if (!enabled) return NO_COMPONENTS;
    const catalog = sourceCatalog?.identity === identity && sourceCatalog.loader === cachedLoader ? sourceCatalog.catalog : undefined;
    if (reused) return {environment:reused,catalog:catalog ?? reused.catalog,pending:false};
    const current = componentPreparationForIdentity(state,identity,cachedLoader);
    // Source edits can change imports while the last environment is still
    // settled. Mark that new source pending in the same render, before the
    // asynchronous preparation starts, so its safe prose need not wait.
    const preparingSource = compile && !pause && (state.source ?? state.environment?.source) !== source;
    return preparingSource ? {...current,catalog,pending:true,error:undefined} : {...current,catalog};
  }, [enabled,reused,state,identity,cachedLoader,compile,pause,source,sourceCatalog]);
}
