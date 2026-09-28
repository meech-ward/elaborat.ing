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

/** The smallest zoom a scene opens at, so its shapes and words stay readable. */
export const READABLE_ZOOM = 0.6;

/**
 * Room a scene keeps from the area's edges when it opens, clear of the canvas
 * islands: on a desktop the tool island at the top and the zoom island at the
 * bottom; on a phone the round buttons at the top and the tool island at the
 * bottom. The same at both ends, so a scene that fits has its middle in the
 * middle of the area.
 */
export const OPENING_MARGIN = {
  default: { x: 32, y: 72 },
  touch: { x: 16, y: 84 },
} as const;

export type OpeningMargin = (typeof OPENING_MARGIN)[keyof typeof OPENING_MARGIN];

/**
 * The zoom and scroll a scene opens at: fitted inside the area, less the
 * margin, never above 100%, with its middle in the middle of the area. A
 * scene that would fit only below READABLE_ZOOM opens at that zoom instead,
 * with its top left corner (in each direction it does not fit) at the
 * margin, so its shapes stay readable. Null when the area has no room.
 */
export function openingViewport(bounds: SceneBounds, area: CanvasArea, margin: OpeningMargin = OPENING_MARGIN.default): CanvasViewport | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const [minX, minY, maxX, maxY] = bounds;
  const room = { width: Math.max(1, area.width - 2 * margin.x), height: Math.max(1, area.height - 2 * margin.y) };
  const fit = Math.min(1, room.width / Math.max(1, maxX - minX), room.height / Math.max(1, maxY - minY));
  const zoom = Math.max(fit, READABLE_ZOOM);
  const { x, y } = centre(area);
  // Excalidraw draws scene point p at (p + scroll) * zoom.
  const scroll = (start: number, middle: number, min: number, max: number, size: number) =>
    (max - min) * zoom <= size ? middle / zoom - (min + max) / 2 : start / zoom - min;
  return {
    zoom,
    scrollX: scroll(area.left + margin.x, x, minX, maxX, room.width),
    scrollY: scroll(area.top + margin.y, y, minY, maxY, room.height),
  };
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

/**
 * What the canvas controls show: the current tool (Excalidraw's name), tool
 * lock, zoom, whether anything is selected, the one element selected (for
 * Comment), and where Excalidraw's menu for an element is open, relative to
 * the canvas (null when it is closed or is the canvas's own menu).
 */
export interface CanvasUi {
  tool: string;
  locked: boolean;
  zoom: number;
  selected: boolean;
  single: string | null;
  elementMenu: { left: number; top: number } | null;
}

/** The parts of Excalidraw's app state the controls read. */
export interface CanvasUiSource {
  activeTool: { type: string; locked: boolean };
  zoom: { value: number };
  selectedElementIds: Readonly<Record<string, unknown>>;
  multiElement?: unknown;
  contextMenu?: { left: number; top: number; items: readonly unknown[] } | null;
}

/** Whether a menu's items are Excalidraw's menu for elements: only it has Copy (the canvas's has Copy as PNG and Paste). */
const isElementMenu = (items: readonly unknown[]) =>
  items.some((item) => typeof item === "object" && item !== null && (item as { name?: unknown }).name === "copy");

export function canvasUiFrom(state: CanvasUiSource): CanvasUi {
  const selectedIds = Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]);
  const menu = state.contextMenu;
  return {
    tool: state.activeTool.type,
    locked: state.activeTool.locked,
    zoom: state.zoom.value,
    selected: Object.keys(state.selectedElementIds).length > 0 || Boolean(state.multiElement),
    single: selectedIds.length === 1 && !state.multiElement ? selectedIds[0] : null,
    elementMenu: menu && isElementMenu(menu.items) ? { left: menu.left, top: menu.top } : null,
  };
}

/** The parts of an Excalidraw element its box comes from. Lines, arrows and freehand have points, relative to x and y. */
export interface ElementGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  points?: readonly (readonly [number, number])[];
}

export interface ScenePoint {
  x: number;
  y: number;
}

/**
 * An element's unrotated box in scene coordinates, and the angle it is
 * turned by around the box's middle (as Excalidraw turns it). A line, arrow
 * or freehand stroke's box is the one around its points.
 */
export function elementBox(element: ElementGeometry): { x: number; y: number; width: number; height: number; angle: number } {
  const angle = element.angle ?? 0;
  if (element.points && element.points.length > 0) {
    const xs = element.points.map(([x]) => x);
    const ys = element.points.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: element.x + minX, y: element.y + minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, angle };
  }
  return { x: element.x, y: element.y, width: element.width, height: element.height, angle };
}

function rotate(point: ScenePoint, centre: ScenePoint, angle: number): ScenePoint {
  if (!angle) return point;
  const [dx, dy] = [point.x - centre.x, point.y - centre.y];
  return { x: centre.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: centre.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

/**
 * The scene point a comment pin marks on an element: `point` (fractions of
 * its unrotated box from the top left), or else its top-right corner,
 * turned with the element.
 */
export function pinScenePoint(element: ElementGeometry, point?: ScenePoint): ScenePoint {
  const box = elementBox(element);
  const at = point ?? { x: 1, y: 0 };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return rotate({ x: box.x + at.x * box.width, y: box.y + at.y * box.height }, centre, box.angle);
}

/**
 * Where a scene point is on an element, as fractions of its unrotated box
 * from the top left, rounded to 4 places: the spot a comment marks. Null
 * when the point is outside the box.
 */
export function elementPoint(element: ElementGeometry, scene: ScenePoint): ScenePoint | null {
  const box = elementBox(element);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const local = rotate(scene, centre, -box.angle);
  const fraction = (value: number, start: number, size: number) => (size > 0 ? (value - start) / size : Math.abs(value - start) <= 1 ? 0.5 : -1);
  const x = fraction(local.x, box.x, box.width);
  const y = fraction(local.y, box.y, box.height);
  const inside = (value: number) => value >= 0 && value <= 1;
  if (!inside(x) || !inside(y)) return null;
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return { x: round(x), y: round(y) };
}

/** A scene point on screen, relative to the canvas's top left corner. */
export function sceneToCanvas(point: ScenePoint, view: CanvasViewport): ScenePoint {
  return { x: (point.x + view.scrollX) * view.zoom, y: (point.y + view.scrollY) * view.zoom };
}

/** The scene point at a place on screen, relative to the canvas's top left corner. */
export function canvasToScene(point: ScenePoint, view: CanvasViewport): ScenePoint {
  return { x: point.x / view.zoom - view.scrollX, y: point.y / view.zoom - view.scrollY };
}

/** The viewport that puts a scene point in the middle of the area, at the same zoom. */
export function centreOn(current: CanvasViewport, area: CanvasArea, point: ScenePoint): CanvasViewport {
  const { x, y } = centre(area);
  return { zoom: current.zoom, scrollX: x / current.zoom - point.x, scrollY: y / current.zoom - point.y };
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
  let current: CanvasUi = { tool: "selection", locked: false, zoom: 1, selected: false, single: null, elementMenu: null };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: CanvasUi) {
      if (
        next.tool === current.tool &&
        next.locked === current.locked &&
        next.zoom === current.zoom &&
        next.selected === current.selected &&
        next.single === current.single &&
        next.elementMenu?.left === current.elementMenu?.left &&
        next.elementMenu?.top === current.elementMenu?.top
      )
        return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export type CanvasUiStore = ReturnType<typeof createCanvasUiStore>;
