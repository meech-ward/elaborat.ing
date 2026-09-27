// Controlled native Excalidraw canvas.
//
// The shell owns the scene, saves and revisions: it passes `scene` in and
// persists what `onChange` returns. Native tools, labels, arrows,
// freehand, undo/redo and zoom all come from the real component; this
// wrapper adds only controlled-state semantics with the raw authored scene
// as the authority:
//
// - initialData loads the scene once; later scene identities (e.g. an
//   agent edit arriving while open) are applied via updateScene.
// - On load Excalidraw emits restoration updates (dropped rawText, filled
//   link/boundElements defaults, regenerated updated/versionNonce,
//   scroll churn). Those are captured as the library baseline and never
//   forwarded, so a no-op reopen produces no onChange at all and the
//   original file bytes survive.
// - Later library events are diffed against that baseline and only the
//   real user delta is overlaid onto raw, field-by-field (see merge.ts),
//   so unknown fields, loose arrows, pressures, image payloads and
//   unrelated ids survive every edit.
// - App state is NOT persisted wholesale: scroll, selection, zoom,
//   collaborators and transient UI never dirty the file. Only the durable
//   canvas prefs (theme, viewBackgroundColor) sync back.
// - External scene identities never echo back as authored edits: the push
//   resets the baseline, so the library's own echo re-baselines quietly,
//   and feeding an emitted scene back in is a referential no-op.
//
// Browser-only and lazily loaded: the native package (pinned in
// package.json) resolves at render time. Unit tests never render this.
//
// Types come from the installed package itself (typeof-import): every API
// shape (onChange arity, updateScene payload, addFiles file array) is
// checked against the real 0.18.1 declarations. The only documented
// bridges are data-shape conversions between the project-owned structural
// scene (which must also typecheck without the package for pure-helper
// tests) and the vendor unions.

import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { mergeLibraryUpdate, snapshotLibraryState } from './merge.ts';
import type { LibrarySnapshot } from './merge.ts';
import type { DrawingCanvasProps, DrawingScene } from './types.ts';
import { ensureGeneratedNativeFont } from './nativeFontReady.ts';
import { initialCanvasAppState } from './initialCanvasAppState.ts';

type NativeExcalidraw = typeof import('@excalidraw/excalidraw')['Excalidraw'];
type NativeProps = ComponentProps<NativeExcalidraw>;
type NativeAPI = Parameters<NonNullable<NativeProps['excalidrawAPI']>>[0];
type NativeOnChange = NonNullable<NativeProps['onChange']>;
type NativeElements = Parameters<NativeOnChange>[0];
type NativeAppState = Parameters<NativeOnChange>[1];
type NativeFiles = Parameters<NativeOnChange>[2];
type NativeFile = NativeFiles[string];

/** Scene push accepted by the vendor updateScene (collaborators never synced). */
interface NativeUpdateScene {
  elements?: NativeElements | null;
  appState?: Partial<NativeAppState> | null;
  captureUpdate?: 'NEVER';
}

const NativeCanvas = lazy(() =>
  Promise.all([import('@excalidraw/excalidraw'), ensureGeneratedNativeFont()]).then(([mod]) => ({
    // React's own Memo wrapper is not a ComponentType statically.
    default: mod.Excalidraw as unknown as ComponentType<NativeProps>,
  })),
);

class CanvasErrorBoundary extends Component<
  { onError?: (message: string) => void; children: ReactNode },
  { failed: string | null }
> {
  constructor(props: { onError?: (message: string) => void; children: ReactNode }) {
    super(props);
    this.state = { failed: null };
  }

  static getDerivedStateFromError(error: unknown): { failed: string | null } {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }

  render(): ReactNode {
    if (this.state.failed !== null) {
      return (
        <div role="alert">
          <p>Drawing canvas failed to load.</p>
          <p>{this.state.failed}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Project scene elements into the vendor union. Runtime scenes originate
 * from the vendor schema (validated element-by-element at the parse
 * boundary), so this is a representation change, not a lossy cast.
 */
function toNativeElements(elements: DrawingScene['elements']): NativeElements {
  return elements as unknown as NativeElements;
}

/**
 * Project app state into the vendor partial. Unknown preserved keys ride
 * along at runtime; the vendor type only names its own prefs.
 */
function toNativeAppState(appState: DrawingScene['appState']): Partial<NativeAppState> | undefined {
  if (appState === undefined) {
    return undefined;
  }
  return { ...appState } as unknown as Partial<NativeAppState>;
}

function toNativeFiles(files: DrawingScene['files']): NativeFiles | undefined {
  if (files === undefined) {
    return undefined;
  }
  const out: Record<string, NativeFile> = {};
  for (const [id, file] of Object.entries(files)) {
    // Brand fields only; the file shape is verified at the parse boundary.
    out[id] = { ...file } as unknown as NativeFile;
  }
  return out as unknown as NativeFiles;
}

/** The vendor addFiles takes a file ARRAY, never the keyed map. */
function toNativeFileList(files: DrawingScene['files']): NativeFile[] {
  if (files === undefined) {
    return [];
  }
  return Object.values(files).map((file) => ({ ...file }) as unknown as NativeFile);
}

function pushScene(api: NativeAPI, target: DrawingScene, onError?: (message: string) => void): void {
  try {
    // The vendor updateScene is generic over the app-state keys it
    // accepts; this narrower signature keeps the actual call strict.
    (api.updateScene as (sceneData: NativeUpdateScene) => void)({
      elements: toNativeElements(target.elements),
      appState: toNativeAppState(target.appState),
    });
    const fileList = toNativeFileList(target.files);
    if (fileList.length > 0) {
      api.addFiles(fileList);
    }
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
  }
}

/** The scene as the canvas shows it; raw when nothing is presented over it. */
function presented(present: DrawingCanvasProps['present'], scene: DrawingScene): DrawingScene {
  return present ? present(scene) : scene;
}

/**
 * Redraw with a new presentation of the same raw scene: only what the
 * presentation changes, and never recorded for undo.
 */
function pushPresentation(api: NativeAPI, raw: DrawingScene, shown: DrawingScene, onError?: (message: string) => void): void {
  try {
    (api.updateScene as (sceneData: NativeUpdateScene) => void)({
      ...(shown.elements === raw.elements ? {} : { elements: toNativeElements(shown.elements) }),
      appState: toNativeAppState(shown.appState),
      captureUpdate: 'NEVER',
    });
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Controlled native drawing canvas. Same native scene powers standalone
 * and referenced drawings; the shell decides which file a scene belongs
 * to. onChange fires only for authored edits, never for load restoration.
 */
export function DrawingCanvas(props: DrawingCanvasProps): ReactNode {
  const { scene, onChange, theme, embedded, autoFocus, viewOnly, present, onError } = props;
  const apiRef = useRef<NativeAPI | null>(null);
  // Raw authored authority: the only state ever forwarded or saved.
  const rawRef = useRef<DrawingScene>(scene);
  // Last library report per load identity; null until the first event
  // after a mount or an external push, which only re-baselines.
  const baselineRef = useRef<LibrarySnapshot | null>(null);
  // Last scene pushed to (or emitted from) the canvas; feeding it back in
  // is a referential no-op, never an authored edit.
  const pushedRef = useRef<DrawingScene>(scene);
  // External scene that arrived before the vendor API was ready.
  const pendingRef = useRef<DrawingScene | null>(null);
  // What the canvas shows over raw (palette colours); never saved.
  const presentRef = useRef(present);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  // Latest callbacks without re-subscribing the native component: effects
  // only, never ref writes during render.
  useEffect(() => {
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
  });

  // Read by the native canvas on mount only; later scenes arrive through
  // updateScene, so this stays stable across re-renders and StrictMode.
  const [initialData] = useState<NativeProps['initialData']>(() => {
    const initial = presented(present, scene);
    return {
      elements: toNativeElements(initial.elements),
      appState: toNativeAppState(initialCanvasAppState(initial.appState)),
      files: toNativeFiles(scene.files),
      scrollToContent: true,
    };
  });

  // External scene identities (agent edits, reloads) replace the raw
  // authority and reset the library baseline, so the vendor echo of the
  // push re-baselines quietly instead of emitting. A parent's own authored
  // echo must retain the baseline: the next native event can be the text
  // commit, with no intervening selection/paint event to re-establish it.
  // A new presentation redraws the raw scene the same way, quietly.
  useEffect(() => {
    const restyled = present !== presentRef.current;
    presentRef.current = present;
    if (scene !== pushedRef.current) {
      pushedRef.current = scene;
      rawRef.current = scene;
      baselineRef.current = null;
      const api = apiRef.current;
      if (api) {
        pushScene(api, presented(present, scene), onErrorRef.current ?? undefined);
      } else {
        pendingRef.current = scene;
      }
    } else if (restyled) {
      baselineRef.current = null;
      const api = apiRef.current;
      if (api) {
        pushPresentation(api, rawRef.current, presented(present, rawRef.current), onErrorRef.current ?? undefined);
      } else {
        pendingRef.current = rawRef.current;
      }
    }
  }, [scene, present]);

  // Reset only when this canvas lifecycle ends, not on every controlled
  // scene echo. StrictMode's effect replay still gets a fresh baseline.
  useEffect(() => () => {
    baselineRef.current = null;
  }, []);

  const handleLibraryChange: NativeOnChange = (elements, appState, files) => {
    let current: LibrarySnapshot;
    try {
      // Workbench appearance is presentation-only, never an authored theme edit.
      current = snapshotLibraryState(elements, files, theme ? {...appState,theme:rawRef.current.appState?.theme} : appState);
    } catch (error) {
      onErrorRef.current?.(error instanceof Error ? error.message : String(error));
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = current;
      return;
    }
    const { next, dirty } = mergeLibraryUpdate(rawRef.current, baselineRef.current, current);
    baselineRef.current = current;
    if (!dirty) {
      return;
    }
    rawRef.current = next;
    pushedRef.current = next;
    onChangeRef.current?.(next, 'authored');
  };

  return (
    <div
      data-testid="drawing-canvas"
      style={{ width: '100%', height: '100%', minHeight: embedded ? 240 : 0 }}
    >
      <CanvasErrorBoundary onError={onError}>
        <Suspense fallback={<div aria-label="Loading drawing canvas">Loading drawing canvas…</div>}>
          <NativeCanvas
            initialData={initialData}
            theme={theme ?? 'light'}
            handleKeyboardGlobally={false}
            detectScroll={props.active !== false}
            viewModeEnabled={viewOnly ?? false}
            zenModeEnabled={embedded ?? false}
            autoFocus={autoFocus ?? false}
            excalidrawAPI={(api: NativeAPI) => {
              apiRef.current = api;
              const pending = pendingRef.current;
              if (pending !== null) {
                pendingRef.current = null;
                pushScene(api, presented(presentRef.current, pending), onErrorRef.current ?? undefined);
              }
            }}
            onChange={handleLibraryChange}
          />
        </Suspense>
      </CanvasErrorBoundary>
    </div>
  );
}
