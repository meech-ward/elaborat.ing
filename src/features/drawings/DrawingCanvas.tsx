// Controlled native Excalidraw canvas.
//
// The shell owns the scene, saves and revisions: it passes `scene` in and
// persists what `onChange` returns. Native tools, labels, arrows,
// freehand, undo/redo and zoom all come from the real component, driven
// from the design system's tool and zoom islands (CanvasControls.tsx) in
// place of its own toolbar and footer, which stay hidden. The scene opens
// fitted into the visible part of the canvas (at most 100%, at least a
// readable zoom), again whenever it is shown again, and keeps its middle
// there while that part moves. Otherwise this wrapper adds only controlled-state semantics with
// the raw authored scene as the authority:
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
// - A scene that arrived from elsewhere (`drawIn`, such as an agent's save)
//   sketches its new elements in (sketchIn.ts): the canvas shows them
//   hidden, outside undo, while an SVG over it draws them stroke by stroke,
//   and shows each one as its sketch ends. The library events report each
//   one's own opacity, so hiding them never reaches raw or marks anything
//   changed. When any of them is out of sight, the view moves to them first
//   (followArrivals), unless the person has used the canvas in the last few
//   seconds; once they start working on it, the rest shows at once.
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

import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ComponentType, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from 'react';
import { flushSync } from 'react-dom';
import { Banner, BannerAction, isApplePlatform } from '@/features/design-system';
import type { CanvasPin } from '@/features/comments';
import { pencil, type Pencil } from '@/features/sketch/pencil.ts';
import { pencilSoundOn, setPencilSound } from '@/features/sketch/pencilSetting.ts';
import { mergeLibraryUpdate, snapshotLibraryState } from './merge.ts';
import type { LibrarySnapshot } from './merge.ts';
import type { DrawingCanvasProps, DrawingScene } from './types.ts';
import { ensureGeneratedNativeFont } from './nativeFontReady.ts';
import { initialCanvasAppState } from './initialCanvasAppState.ts';
import { arrivingElements, withOpacities } from './drawIn.ts';
import { createSketchSoundStore, sketchIn, type Sketch } from './sketchIn.ts';
import { CanvasControls, type CanvasCommands } from './CanvasControls.tsx';
import {
  CanvasPins,
  ElementMenuComment,
  SelectedElementComment,
  commentButtonPlace,
  createCommentButtonStore,
  createPinPlacesStore,
  pinPlaces,
  type PinElement,
} from './CanvasComments.tsx';
import {
  OPENING_MARGIN,
  READABLE_ZOOM,
  areaOffsets,
  boundsInView,
  canvasToScene,
  canvasUiFrom,
  centreOn,
  createCanvasUiStore,
  elementAt,
  elementBox,
  elementPoint,
  followArea,
  openingViewport,
  zoomViewport,
  type CanvasArea,
  type CanvasViewport,
  type HitElement,
  type OpeningMargin,
  type ScenePoint,
} from './canvasView.ts';
import './drawingCanvas.css';

type NativeExcalidraw = typeof import('@excalidraw/excalidraw')['Excalidraw'];
type NativeProps = ComponentProps<NativeExcalidraw>;
type NativeAPI = Parameters<NonNullable<NativeProps['excalidrawAPI']>>[0];
type NativeOnChange = NonNullable<NativeProps['onChange']>;
type NativeElements = Parameters<NativeOnChange>[0];
type NativeAppState = Parameters<NativeOnChange>[1];
type NativeFiles = Parameters<NativeOnChange>[2];
type NativeFile = NativeFiles[string];
type NativeTool = Exclude<NativeAppState['activeTool']['type'], 'image' | 'custom'>;

/** Scene push accepted by the vendor updateScene (collaborators never synced). */
interface NativeUpdateScene {
  elements?: NativeElements | null;
  appState?: Partial<NativeAppState> | null;
  captureUpdate?: 'NEVER';
}

// The vendor's element restore, scene bounds and SVG export, once the package has loaded.
let restoreNative: typeof import('@excalidraw/excalidraw')['restoreElements'] | null = null;
let boundsNative: typeof import('@excalidraw/excalidraw')['getCommonBounds'] | null = null;
let exportNative: typeof import('@excalidraw/excalidraw')['exportToSvg'] | null = null;

const NativeCanvas = lazy(() =>
  Promise.all([import('@excalidraw/excalidraw'), ensureGeneratedNativeFont()]).then(([mod]) => {
    restoreNative = mod.restoreElements;
    boundsNative = mod.getCommonBounds;
    exportNative = mod.exportToSvg;
    // React's own Memo wrapper is not a ComponentType statically.
    return { default: mod.Excalidraw as unknown as ComponentType<NativeProps> };
  }),
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
        <Banner tone="danger" className="m-4 w-auto" action={<BannerAction onClick={() => this.setState({ failed: null })}>Try again</BannerAction>}>
          Drawing canvas failed to load: {this.state.failed}
        </Banner>
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
 * Elements for updateScene, restored the way Excalidraw restores a scene it
 * opens: defaults filled in and unknown types left out, so a half-written
 * element (for example one being typed in the source) cannot break the
 * canvas. Display only; the raw scene is unchanged.
 */
function toShownElements(elements: DrawingScene['elements']): NativeElements {
  const native = toNativeElements(elements);
  return restoreNative ? restoreNative(native, null, { repairBindings: true }) : native;
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
      elements: toShownElements(target.elements),
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

/** How long after the person last used the canvas (a pointer, the wheel or a key on it) the view stays where they left it. */
const LEFT_ALONE_MS = 3000;
/** How long the view takes to move to elements that arrived out of sight; their sketch starts after. */
const FOLLOW_MS = 500;

/**
 * Brings elements that just arrived into view when any of them is out of
 * sight (outside the area, less the margin that keeps clear of the islands):
 * Excalidraw's scrollToContent puts them in the middle of the area at the
 * same zoom, zooming out only as far as it takes to fit them, and not below a
 * readable zoom. Not while the person is drawing a shape or line or editing
 * text. Animated over FOLLOW_MS unless `animate` is false. Only the view
 * moves: nothing is recorded for undo, and the file does not change. True
 * when the view moved.
 */
function followArrivals(api: NativeAPI, ids: ReadonlyMap<string, number>, area: CanvasArea, margin: OpeningMargin, animate: boolean): boolean {
  const state = api.getAppState();
  if (!boundsNative || state.newElement || state.multiElement || state.editingTextElement || state.editingLinearElement) return false;
  const arrived = api.getSceneElements().filter((element) => ids.has(element.id));
  if (arrived.length === 0) return false;
  const zoom = state.zoom.value;
  if (boundsInView(boundsNative(arrived), { zoom, scrollX: state.scrollX, scrollY: state.scrollY }, area, margin)) return false;
  api.scrollToContent(arrived, {
    fitToViewport: true,
    maxZoom: zoom,
    minZoom: Math.min(zoom, READABLE_ZOOM),
    canvasOffsets: areaOffsets(state, area, margin),
    animate,
    duration: FOLLOW_MS,
  });
  return true;
}

/** The scene as the canvas shows it; raw when nothing is presented over it. */
function presented(present: DrawingCanvasProps['present'], scene: DrawingScene): DrawingScene {
  return present ? present(scene) : scene;
}

/** The part of the canvas a person can see (the controls' layer), relative to the canvas; null while it is hidden. */
function visibleAreaOf(wrapper: HTMLElement | null, area: HTMLElement | null): CanvasArea | null {
  if (!wrapper || !area) return null;
  const box = wrapper.getBoundingClientRect();
  const view = area.getBoundingClientRect();
  if (view.width === 0 || view.height === 0) return null;
  return { left: view.left - box.left, top: view.top - box.top, width: view.width, height: view.height };
}

/** The scene's elements as the comment pins read them (geometry and id). */
function pinElements(elements: readonly unknown[]): readonly PinElement[] {
  return elements as readonly PinElement[];
}

/** Pan and zoom the canvas, outside undo. */
function setViewport(api: NativeAPI, view: CanvasViewport): void {
  (api.updateScene as (sceneData: NativeUpdateScene) => void)({
    appState: { zoom: { value: view.zoom as NativeAppState['zoom']['value'] }, scrollX: view.scrollX, scrollY: view.scrollY },
    captureUpdate: 'NEVER',
  });
}

/**
 * Redraw with a new presentation of the same raw scene: only what the
 * presentation changes, and never recorded for undo.
 */
function pushPresentation(api: NativeAPI, raw: DrawingScene, shown: DrawingScene, onError?: (message: string) => void): void {
  try {
    (api.updateScene as (sceneData: NativeUpdateScene) => void)({
      ...(shown.elements === raw.elements ? {} : { elements: toShownElements(shown.elements) }),
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
  const { scene, onChange, theme, embedded, autoFocus, viewOnly, present, drawIn = null, onScrollChange, onShown, compact = false, onError, comments = null, apiRef: pageApiRef } = props;
  const apiRef = useRef<NativeAPI | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The canvas controls' layer, which covers the part of the canvas a person can see.
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [ui] = useState(createCanvasUiStore);
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
  // The canvas has shown its first scene.
  const loadedRef = useRef(false);
  // What the canvas shows over raw (palette colours); never saved.
  const presentRef = useRef(present);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const onScrollRef = useRef(onScrollChange);
  const onShownRef = useRef(onShown);
  const commentsRef = useRef(comments);
  // Someone who may comment but not change the drawing: a click selects an
  // element (Excalidraw selects none in view mode), and the Comment button
  // over it starts the comment. Offline the button stays, off, saying why.
  const pickToComment = Boolean(viewOnly && (comments?.canComment || comments?.offline));
  const pickRef = useRef(pickToComment);
  // Latest callbacks without re-subscribing the native component: effects
  // only, never ref writes during render.
  useEffect(() => {
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
    onScrollRef.current = onScrollChange;
    onShownRef.current = onShown;
    commentsRef.current = comments;
    pickRef.current = pickToComment;
  });

  /** The visible part of the canvas, relative to the canvas; null while it is hidden. */
  const visibleArea = (): CanvasArea | null => visibleAreaOf(wrapperRef.current, areaRef.current);

  // The person's use of the canvas: the pointers down on it, and when they
  // last pressed or let go of one, turned the wheel or pressed a key there
  // (or went to an element from the comments). The view follows arriving
  // elements only when the canvas has been left alone (followArrivals).
  const heldRef = useRef(new Set<number>());
  const usedAtRef = useRef(-Infinity);
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (heldRef.current.delete(event.pointerId)) usedAtRef.current = performance.now();
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
  }, []);
  // The sketch of elements that arrived from elsewhere (sketchIn.ts): the
  // elements, with the opacity each ends at, and the sketch; the pencil it
  // sounds with, made for the first one; what its sound control shows; and
  // the layer over the canvas it draws in.
  const drawingInRef = useRef<{ arriving: ReadonlyMap<string, number>; sketch: Sketch } | null>(null);
  const penRef = useRef<Pencil | null>(null);
  const [sketchSound] = useState(() => createSketchSoundStore(pencilSoundOn()));
  const sketchHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => {
    const current = drawingInRef.current;
    drawingInRef.current = null;
    current?.sketch.stop();
    penRef.current?.close();
    penRef.current = null;
  }, []);
  const toggleSound = useCallback(() => {
    const on = !sketchSound.get().on;
    setPencilSound(on);
    penRef.current?.set(on);
    sketchSound.set({ ...sketchSound.get(), on });
  }, [sketchSound]);
  /** The person used the canvas. On the canvas itself, not its controls, a sketch still going shows the rest at once. */
  const onUse = (event: SyntheticEvent) => {
    usedAtRef.current = performance.now();
    if (event.target instanceof Element && event.target.closest('.excalidraw')) drawingInRef.current?.sketch.finish();
  };

  // Comment pins follow their elements and the view: placed again on every
  // change the canvas reports, and when the pins change. So does the
  // Comment button over the selected element, when there is one.
  const [pinStore] = useState(createPinPlacesStore);
  const [commentButton] = useState(createCommentButtonStore);
  const layoutPins = (elements: readonly unknown[], state: { zoom: { value: number }; scrollX: number; scrollY: number; selectedElementIds: Readonly<Record<string, unknown>> }) => {
    const view = { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY };
    pinStore.set(pinPlaces(commentsRef.current?.pins ?? [], pinElements(elements), view));
    const selected = Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]);
    // Not while a new comment is being written on that element: its draft pin shows it.
    const element = pickRef.current && selected.length === 1 && selected[0] !== commentsRef.current?.composing ? pinElements(elements).find((candidate) => candidate.id === selected[0] && !candidate.isDeleted) : undefined;
    const area = element ? visibleArea() : null;
    commentButton.set(element && area ? commentButtonPlace(element, view, area, compact ? { height: 40, half: 70 } : { height: 32, half: 90 }) : null);
  };
  const pins = comments?.pins;
  useEffect(() => {
    const api = apiRef.current;
    if (api) layoutPins(api.getSceneElements(), api.getAppState());
    else pinStore.set(new Map());
  });
  // Where the last click landed on an element, as a spot on it: More tools
  // and the comment key comment there when that element is the selected one.
  const lastSpotRef = useRef<{ elementId: string; point: ScenePoint | null } | null>(null);
  const stopPointerRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    stopPointerRef.current?.();
    stopPointerRef.current = null;
  }, []);

  /** Comment on an element, at a scene point on it (kept if it is on the element). */
  const commentOn = useCallback((elementId: string, at: ScenePoint | null) => {
    const api = apiRef.current;
    const current = commentsRef.current;
    if (!api || !current?.canComment) return;
    const element = api.getSceneElements().find((candidate) => candidate.id === elementId);
    if (!element) return;
    const point = at ? elementPoint(pinElements([element])[0], at) : null;
    current.onComment({ elementId, ...(point ? { point } : {}) });
  }, []);
  /** Comment on the one selected element (More tools, the comment key). */
  const commentOnSelected = useCallback(() => {
    const elementId = ui.get().single;
    if (!elementId) return;
    const spot = lastSpotRef.current;
    const api = apiRef.current;
    const element = api?.getSceneElements().find((candidate) => candidate.id === elementId);
    if (!element) return;
    const current = commentsRef.current;
    if (!current?.canComment) return;
    const point = spot?.elementId === elementId ? spot.point : null;
    current.onComment({ elementId, ...(point ? { point } : {}) });
  }, [ui]);
  /** Comment from Excalidraw's menu for an element: close it, and comment where it was opened. */
  const commentFromMenu = useCallback((elementId: string, at: { x: number; y: number }) => {
    const api = apiRef.current;
    if (!api) return;
    (api.updateScene as (sceneData: NativeUpdateScene) => void)({ appState: { contextMenu: null }, captureUpdate: 'NEVER' });
    const state = api.getAppState();
    commentOn(elementId, canvasToScene(at, { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY }));
  }, [commentOn]);
  // ⌘⌥M or Ctrl+Alt+M on the canvas comments on the selected element; with
  // nothing selected the page takes it (it shows and hides the comments).
  const onCommentKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!commentsRef.current?.canComment || event.code !== 'KeyM' || !event.altKey || event.shiftKey) return;
    const apple = isApplePlatform();
    if (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('textarea, input')) return;
    if (!ui.get().single) return;
    event.preventDefault();
    commentOnSelected();
  };
  const openPin = useCallback((pin: CanvasPin) => commentsRef.current?.onOpen(pin), []);
  // In view mode a click (not a drag, which pans) on an element selects it, at the spot clicked.
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const onPickDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    downRef.current = event.button === 0 && event.target instanceof HTMLCanvasElement ? { x: event.clientX, y: event.clientY } : null;
  };
  const onUseDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    heldRef.current.add(event.pointerId);
    onUse(event);
    if (pickToComment) onPickDown(event);
  };
  const onPickUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = downRef.current;
    downRef.current = null;
    const api = apiRef.current;
    const wrapper = wrapperRef.current;
    if (!down || !api || !wrapper || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const box = wrapper.getBoundingClientRect();
    const state = api.getAppState();
    const at = canvasToScene({ x: event.clientX - box.left, y: event.clientY - box.top }, { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY });
    const elements = api.getSceneElements() as unknown as readonly HitElement[];
    const elementId = elementAt(elements, at, 6 / state.zoom.value);
    const element = elementId ? elements.find((candidate) => candidate.id === elementId) : undefined;
    lastSpotRef.current = element ? { elementId: element.id, point: elementPoint(element, at) } : null;
    // After Excalidraw's own pointer up, which lets go of the selection in view mode.
    (api.updateScene as (sceneData: NativeUpdateScene) => void)({
      appState: { selectedElementIds: (element ? { [element.id]: true } : {}) as NativeAppState['selectedElementIds'] },
      captureUpdate: 'NEVER',
    });
  };

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
  // A new presentation redraws the raw scene the same way, quietly. A scene
  // that arrived from elsewhere (`drawIn`) sketches its new elements in on a
  // canvas that shows, unless the person prefers reduced motion, and the view
  // first follows them when they are out of sight and the person has left
  // the canvas alone for a while.
  const shownNow = props.active !== false;
  useEffect(() => {
    const restyled = present !== presentRef.current;
    presentRef.current = present;
    if (scene !== pushedRef.current) {
      const before = rawRef.current;
      pushedRef.current = scene;
      rawRef.current = scene;
      baselineRef.current = null;
      // A sketch still going ends here: the scene pushed below shows its elements.
      const previous = drawingInRef.current;
      drawingInRef.current = null;
      previous?.sketch.stop();
      const api = apiRef.current;
      if (api) {
        const shown = presented(present, scene);
        const arriving = loadedRef.current && scene === drawIn ? arrivingElements(before, scene) : null;
        const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
        const host = sketchHostRef.current;
        const exportSvg = exportNative;
        const bounds = boundsNative;
        const sketching = arriving !== null && arriving.size > 0 && motion && shownNow && host !== null && exportSvg !== null && bounds !== null;
        if (sketching) {
          // They arrive unseen, then are sketched in.
          pushScene(api, { ...shown, elements: withOpacities(shown.elements, new Map([...arriving.keys()].map((id) => [id, 0]))) }, onErrorRef.current ?? undefined);
        } else {
          pushScene(api, shown, onErrorRef.current ?? undefined);
        }
        const area = visibleAreaOf(wrapperRef.current, areaRef.current);
        const leftAlone = heldRef.current.size === 0 && performance.now() - usedAtRef.current >= LEFT_ALONE_MS;
        const moved = arriving !== null && arriving.size > 0 && area !== null && leftAlone && followArrivals(api, arriving, area, OPENING_MARGIN[compact ? 'touch' : 'default'], motion);
        if (sketching) {
          penRef.current ??= pencil(sketchSound.get().on);
          const sketch: Sketch = sketchIn({
            host,
            surface: () => wrapperRef.current?.querySelector('.excalidraw__canvas.static') ?? null,
            elements: api.getSceneElements(),
            arriving,
            exportSvg: (elements, padding) =>
              exportSvg({
                elements,
                appState: { exportBackground: false, exportScale: 1, exportWithDarkMode: false, viewBackgroundColor: api.getAppState().viewBackgroundColor },
                files: api.getFiles(),
                exportPadding: padding,
                skipInliningFonts: true,
              }),
            bounds: (elements) => bounds(elements),
            view: () => {
              const state = api.getAppState();
              return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, dark: state.theme === 'dark' };
            },
            // On the canvas before the next paint, as the sketch goes: Excalidraw draws in an effect, which a sync update runs at once.
            reveal: (ids, now) => {
              const own = new Map(ids.map((id) => [id, arriving.get(id) ?? 100]));
              const show = () =>
                (api.updateScene as (sceneData: NativeUpdateScene) => void)({
                  elements: withOpacities(api.getSceneElementsIncludingDeleted(), own),
                  captureUpdate: 'NEVER',
                });
              if (now) flushSync(show);
              else show();
            },
            // The view moves to them first.
            delay: moved ? FOLLOW_MS : 0,
            pen: () => penRef.current,
            onDone: () => {
              if (drawingInRef.current?.sketch === sketch) drawingInRef.current = null;
              sketchSound.set({ ...sketchSound.get(), playing: drawingInRef.current !== null });
            },
          });
          drawingInRef.current = { arriving, sketch };
          sketchSound.set({ ...sketchSound.get(), playing: true });
        }
      } else {
        pendingRef.current = scene;
      }
    } else if (restyled) {
      baselineRef.current = null;
      // A sketch still going shows the rest at once: the canvas is drawn again in new colours.
      const previous = drawingInRef.current;
      drawingInRef.current = null;
      previous?.sketch.finish(false);
      const api = apiRef.current;
      if (api) {
        pushPresentation(api, rawRef.current, presented(present, rawRef.current), onErrorRef.current ?? undefined);
      } else {
        pendingRef.current = rawRef.current;
      }
    }
  }, [scene, present, drawIn, compact, shownNow, sketchSound]);

  // The scene opens fitted into the visible area, clear of the islands, when
  // it first loads and whenever the canvas is shown again (another tab or the
  // source was in front), once it can be measured. While it shows, it fits
  // the area again when the area moves or changes size (focus mode, Split,
  // the side panel, the window) until someone pans or zooms it; after that
  // the scene point in the middle of the area stays there.
  const openWantedRef = useRef(true);
  // The area the view was last placed for; null while it cannot be measured.
  const placedRef = useRef<CanvasArea | null>(null);
  // The fitted views set since the scene last opened, while nobody has
  // panned or zoomed it (Excalidraw reports each one back as a scroll change,
  // perhaps after the next was set); empty once someone has.
  const fittedRef = useRef<CanvasViewport[]>([]);
  const placeScene = () => {
    const api = apiRef.current;
    if (!api || !loadedRef.current || !boundsNative) return;
    const area = visibleArea();
    const placed = placedRef.current;
    placedRef.current = area;
    if (!area) return;
    if (openWantedRef.current || fittedRef.current.length > 0) {
      openWantedRef.current = false;
      const elements = api.getSceneElements();
      const view = elements.length > 0 ? openingViewport(boundsNative(elements), area, OPENING_MARGIN[compact ? 'touch' : 'default']) : null;
      fittedRef.current = view ? [...fittedRef.current.slice(-3), view] : [];
      if (view) setViewport(api, view);
      return;
    }
    if (!placed || (placed.left === area.left && placed.top === area.top && placed.width === area.width && placed.height === area.height)) return;
    const state = api.getAppState();
    setViewport(api, followArea({ zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY }, placed, area));
  };
  const scrolled = (scrollX: number, scrollY: number, zoom: number) => {
    const fitted = fittedRef.current;
    if (fitted.length > 0 && !fitted.some((view) => view.scrollX === scrollX && view.scrollY === scrollY && view.zoom === zoom)) fittedRef.current = [];
  };
  const shownRef = useRef(props.active !== false);
  useEffect(() => {
    const shown = props.active !== false;
    const wasShown = shownRef.current;
    shownRef.current = shown;
    // Hidden while a sketch goes: the rest shows at once, in silence.
    if (!shown) drawingInRef.current?.sketch.finish(false);
    if (!shown || wasShown) return;
    openWantedRef.current = true;
    // After the page has placed the canvas area (its effects run after this
    // one). Once unmounted there is no area, so this does nothing.
    requestAnimationFrame(placeScene);
  });
  // The area (the controls' layer) loads with the canvas, so it is watched
  // from the first load on.
  const areaObserverRef = useRef<ResizeObserver | null>(null);
  const watchArea = () => {
    const area = areaRef.current;
    if (!area || areaObserverRef.current) return;
    areaObserverRef.current = new ResizeObserver(placeScene);
    areaObserverRef.current.observe(area);
  };
  useEffect(() => () => {
    areaObserverRef.current?.disconnect();
    areaObserverRef.current = null;
  }, []);

  // Reset only when this canvas lifecycle ends, not on every controlled
  // scene echo. StrictMode's effect replay still gets a fresh baseline.
  useEffect(() => () => {
    baselineRef.current = null;
  }, []);

  const handleLibraryChange: NativeOnChange = (elements, appState, files) => {
    ui.set(canvasUiFrom(appState, ui.get()));
    layoutPins(elements, appState);
    let current: LibrarySnapshot;
    // Elements drawing in report their own opacity, not the one the canvas shows now.
    const arriving = drawingInRef.current?.arriving;
    try {
      // Workbench appearance is presentation-only, never an authored theme edit.
      current = snapshotLibraryState(arriving ? withOpacities(elements, arriving) : elements, files, theme ? {...appState,theme:rawRef.current.appState?.theme} : appState);
    } catch (error) {
      onErrorRef.current?.(error instanceof Error ? error.message : String(error));
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = current;
      if (!loadedRef.current) {
        loadedRef.current = true;
        placeScene();
        watchArea();
        onShownRef.current?.();
      }
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

  const historyButton = (name: 'undo' | 'redo') => wrapperRef.current?.querySelector<HTMLButtonElement>(`[data-testid="button-${name}"]`) ?? null;
  const canvasElement = () => wrapperRef.current?.querySelector<HTMLElement>('.excalidraw') ?? null;
  const commands: CanvasCommands = {
    pickTool: (tool) => {
      const api = apiRef.current;
      if (!api) return;
      if (tool === 'image') api.setActiveTool({ type: 'image', insertOnCanvasDirectly: compact });
      else api.setActiveTool({ type: tool as NativeTool });
      // As Excalidraw's own toolbar does: the canvas takes the keyboard.
      canvasElement()?.focus();
    },
    toggleLock: () => {
      const api = apiRef.current;
      if (!api) return;
      const tool = api.getAppState().activeTool;
      if (tool.locked) api.setActiveTool({ type: 'selection', locked: false });
      else (api.updateScene as (sceneData: NativeUpdateScene) => void)({ appState: { activeTool: { ...tool, locked: true } }, captureUpdate: 'NEVER' });
    },
    // Excalidraw's history is not in its API: its own (hidden) buttons run it.
    undo: () => historyButton('undo')?.click(),
    redo: () => historyButton('redo')?.click(),
    history: () => ({ undo: historyButton('undo')?.disabled === false, redo: historyButton('redo')?.disabled === false }),
    toggleLibrary: () => {
      apiRef.current?.toggleSidebar({ name: 'default', tab: 'library' });
    },
    openMermaid: () => {
      const api = apiRef.current;
      if (api) (api.updateScene as (sceneData: NativeUpdateScene) => void)({ appState: { openDialog: { name: 'ttd', tab: 'mermaid' } } });
    },
    zoomTo: (zoom) => {
      const api = apiRef.current;
      const area = visibleArea();
      if (!api || !area) return;
      const state = api.getAppState();
      setViewport(api, zoomViewport({ zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY }, area, zoom));
    },
    canvas: canvasElement,
  };

  // The page's handle: show an element (the comments panel's Go to).
  useEffect(() => {
    if (!pageApiRef) return;
    pageApiRef.current = {
      revealElement: (elementId, focus = true) => {
        const api = apiRef.current;
        const area = visibleArea();
        const element = api?.getSceneElements().find((candidate) => candidate.id === elementId);
        if (!api || !area || !element) return false;
        usedAtRef.current = performance.now();
        const box = elementBox(pinElements([element])[0]);
        const state = api.getAppState();
        setViewport(api, centreOn({ zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY }, area, { x: box.x + box.width / 2, y: box.y + box.height / 2 }));
        (api.updateScene as (sceneData: NativeUpdateScene) => void)({
          appState: { selectedElementIds: { [elementId]: true } as NativeAppState['selectedElementIds'] },
          captureUpdate: 'NEVER',
        });
        if (focus) canvasElement()?.focus();
        return true;
      },
    };
    return () => {
      pageApiRef.current = null;
    };
  });

  const canComment = Boolean(comments?.canComment);
  return (
    <div
      ref={wrapperRef}
      data-testid="drawing-canvas"
      data-slot="drawing-canvas"
      className="relative"
      style={{ width: '100%', height: '100%', minHeight: embedded ? 240 : 0 }}
      onKeyDown={comments ? onCommentKey : undefined}
      onKeyDownCapture={onUse}
      onWheelCapture={onUse}
      onPointerDownCapture={onUseDown}
      onPointerUp={pickToComment ? onPickUp : undefined}
    >
      <CanvasErrorBoundary onError={onError}>
        <Suspense fallback={<div aria-label="Loading drawing canvas" className="p-3 text-[13px] text-muted-foreground">Loading drawing canvas…</div>}>
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
              stopPointerRef.current?.();
              stopPointerRef.current = api.onPointerDown((_tool, pointerDown) => {
                const hit = pointerDown.hit.element;
                lastSpotRef.current = hit ? { elementId: hit.id, point: elementPoint(pinElements([hit])[0], pointerDown.origin) } : null;
              });
              const pending = pendingRef.current;
              if (pending !== null) {
                pendingRef.current = null;
                pushScene(api, presented(presentRef.current, pending), onErrorRef.current ?? undefined);
              }
            }}
            onChange={handleLibraryChange}
            onScrollChange={(scrollX, scrollY, zoom) => {
              scrolled(scrollX, scrollY, zoom.value);
              onScrollRef.current?.(scrollX, scrollY, zoom.value);
            }}
          />
          {/* Arriving elements are sketched in here (sketchIn.ts): over the canvas, under its selection and controls. */}
          <div ref={sketchHostRef} data-slot="canvas-sketch" className="pointer-events-none absolute inset-0 z-[1]" />
          {pins && pins.length > 0 && <CanvasPins pins={pins} places={pinStore} onOpen={openPin} />}
          {canComment && comments && <ElementMenuComment store={ui} wrapperRef={wrapperRef} shortcut={comments.shortcut} onComment={commentFromMenu} />}
          {pickToComment && comments && (
            <SelectedElementComment
              place={commentButton}
              size={compact ? 'touch' : 'default'}
              shortcut={comments.shortcut}
              offline={!comments.canComment}
              onComment={commentOnSelected}
            />
          )}
          <CanvasControls
            store={ui}
            commands={commands}
            areaRef={areaRef}
            size={compact ? 'touch' : 'default'}
            viewOnly={viewOnly ?? false}
            comment={canComment && comments ? { shortcut: comments.shortcut, onComment: commentOnSelected } : null}
            sound={{ store: sketchSound, onToggle: toggleSound }}
          />
        </Suspense>
      </CanvasErrorBoundary>
    </div>
  );
}
