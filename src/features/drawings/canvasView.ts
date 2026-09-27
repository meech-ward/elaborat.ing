// The canvas controls' view of Excalidraw, without React or the package:
// which tool is current (in the tool island's names), the zoom, and the
// scroll that opens a scene in the part of the canvas a person can see and
// keeps it there when that part moves.
//
// Excalidraw draws a scene point at `(x + scrollX) * zoom` from its
// container's left edge (and the same for y), so opening, following and
// zooming are all about keeping one scene point at one place on screen.

/** Excalidraw's zoom limits and its zoom buttons' step. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;
export const ZOOM_STEP = 0.1;

/** The part of the canvas a person can see, relative to the canvas's top left corner. */
export interface CanvasArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A scene's extent: [minX, minY, maxX, maxY], as Excalidraw's getCommonBounds gives it. */
export type SceneBounds = readonly [number, number, number, number];

export interface CanvasViewport {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

const centre = (area: CanvasArea) => ({ x: area.left + area.width / 2, y: area.top + area.height / 2 });

/**
 * The zoom and scroll a scene opens at: 100%, with the middle of the scene
 * in the middle of the area. A scene larger than the area shows its middle,
 * readable, as Excalidraw opens one. Null when the area has no room.
 */
export function openingViewport(bounds: SceneBounds, area: CanvasArea): CanvasViewport | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const [minX, minY, maxX, maxY] = bounds;
  const { x, y } = centre(area);
  return { zoom: 1, scrollX: x - (minX + maxX) / 2, scrollY: y - (minY + maxY) / 2 };
}

/**
 * The viewport after the area moved or changed size (focus mode, Split, the
 * side panel, the window), keeping the scene point that was at its middle
 * at its new middle.
 */
export function followArea(current: CanvasViewport, from: CanvasArea, to: CanvasArea): CanvasViewport {
  const before = centre(from);
  const after = centre(to);
  return {
    zoom: current.zoom,
    scrollX: current.scrollX + (after.x - before.x) / current.zoom,
    scrollY: current.scrollY + (after.y - before.y) / current.zoom,
  };
}

/** The viewport at another zoom (within Excalidraw's limits), with the area's centre on the same scene point. */
export function zoomViewport(current: CanvasViewport, area: CanvasArea, zoom: number): CanvasViewport {
  const next = clampZoom(zoom);
  const centreX = area.left + area.width / 2;
  const centreY = area.top + area.height / 2;
  return {
    zoom: next,
    scrollX: current.scrollX + centreX / next - centreX / current.zoom,
    scrollY: current.scrollY + centreY / next - centreY / current.zoom,
  };
}

/** What the canvas controls show: the current tool (Excalidraw's name), tool lock, zoom and whether anything is selected. */
export interface CanvasUi {
  tool: string;
  locked: boolean;
  zoom: number;
  selected: boolean;
}

/** The parts of Excalidraw's app state the controls read. */
export interface CanvasUiSource {
  activeTool: { type: string; locked: boolean };
  zoom: { value: number };
  selectedElementIds: Readonly<Record<string, unknown>>;
  multiElement?: unknown;
}

export function canvasUiFrom(state: CanvasUiSource): CanvasUi {
  return {
    tool: state.activeTool.type,
    locked: state.activeTool.locked,
    zoom: state.zoom.value,
    selected: Object.keys(state.selectedElementIds).length > 0 || Boolean(state.multiElement),
  };
}

// The tool island's names for the tools Excalidraw names differently.
const islandNames: Record<string, string> = { selection: "select", freedraw: "draw" };
const nativeNames: Record<string, string> = { select: "selection", draw: "freedraw" };

/** The island's name for an Excalidraw tool (selection is "select", freedraw is "draw"). */
export const islandTool = (native: string) => islandNames[native] ?? native;
/** Excalidraw's name for an island tool. */
export const nativeTool = (island: string) => nativeNames[island] ?? island;

/**
 * The controls' state, fed by Excalidraw's change events and read with
 * useSyncExternalStore, so only the controls redraw when it changes.
 */
export function createCanvasUiStore() {
  let current: CanvasUi = { tool: "selection", locked: false, zoom: 1, selected: false };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: CanvasUi) {
      if (next.tool === current.tool && next.locked === current.locked && next.zoom === current.zoom && next.selected === current.selected) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export type CanvasUiStore = ReturnType<typeof createCanvasUiStore>;
