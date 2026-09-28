import { describe, expect, test } from "bun:test";
import {
  OPENING_MARGIN,
  READABLE_ZOOM,
  canvasToScene,
  canvasUiFrom,
  centreOn,
  createCanvasUiStore,
  elementPoint,
  followArea,
  islandTool,
  nativeTool,
  openingViewport,
  pinScenePoint,
  sceneToCanvas,
  zoomViewport,
  type CanvasArea,
  type CanvasViewport,
} from "./canvasView";

/** Where a scene point lands on the canvas. */
const onScreen = (view: CanvasViewport, x: number, y: number) => ({ x: (x + view.scrollX) * view.zoom, y: (y + view.scrollY) * view.zoom });

// A 1440 by 900 canvas with the side panel's 280 and the top line's 60 covering it.
const area: CanvasArea = { left: 280, top: 60, width: 1160, height: 840 };

describe("openingViewport", () => {
  test("centres a small scene in the visible area at 100%", () => {
    const view = openingViewport([100, 100, 300, 200], area)!;
    expect(view.zoom).toBe(1);
    expect(onScreen(view, 200, 150)).toEqual({ x: 280 + 580, y: 60 + 420 });
  });

  test("fits a scene wider than the area inside it, clear of the islands, its middle in the middle", () => {
    // C5's drawing: 1300 wide, beside the side panel.
    const view = openingViewport([120, 170, 1420, 740], area)!;
    expect(view.zoom).toBeCloseTo((1160 - 2 * OPENING_MARGIN.default.x) / 1300);
    expect(onScreen(view, 770, 455).x).toBeCloseTo(280 + 580);
    expect(onScreen(view, 770, 455).y).toBeCloseTo(60 + 420);
    expect(onScreen(view, 120, 170).x).toBeCloseTo(280 + OPENING_MARGIN.default.x);
    expect(onScreen(view, 1420, 740).x).toBeCloseTo(1440 - OPENING_MARGIN.default.x);
    // The whole window (focus mode) has room for it at 100%.
    expect(openingViewport([120, 170, 1420, 740], { left: 0, top: 0, width: 1440, height: 900 })!.zoom).toBe(1);
  });

  test("opens a scene too big to read when fitted at the readable zoom, its top left corner at the margin", () => {
    // The same drawing on a phone.
    const phone: CanvasArea = { left: 0, top: 0, width: 390, height: 844 };
    const view = openingViewport([120, 170, 1420, 740], phone, OPENING_MARGIN.touch)!;
    expect(view.zoom).toBe(READABLE_ZOOM);
    expect(onScreen(view, 120, 170).x).toBeCloseTo(OPENING_MARGIN.touch.x);
    // 570 high at 60% fits the height, so it stays in the middle that way.
    expect(onScreen(view, 770, 455).y).toBeCloseTo(422);
  });

  test("has nothing to open into when the canvas is hidden", () => {
    expect(openingViewport([0, 0, 10, 10], { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});

describe("followArea", () => {
  test("keeps the scene point at the area's middle there when the side panel and top line go (focus mode) and come back", () => {
    const full: CanvasArea = { left: 0, top: 0, width: 1440, height: 900 };
    const start: CanvasViewport = { zoom: 0.5, scrollX: 300, scrollY: -20 };
    const middle = { x: (860 / start.zoom) - start.scrollX, y: (480 / start.zoom) - start.scrollY };
    const focused = followArea(start, area, full);
    expect(focused.zoom).toBe(0.5);
    expect(onScreen(focused, middle.x, middle.y)).toEqual({ x: 720, y: 450 });
    const back = followArea(focused, full, area);
    expect(back.scrollX).toBeCloseTo(start.scrollX);
    expect(back.scrollY).toBeCloseTo(start.scrollY);
  });
});

describe("zoomViewport", () => {
  test("keeps the scene point at the area's centre in place, within Excalidraw's limits", () => {
    const start: CanvasViewport = { zoom: 1, scrollX: -40, scrollY: 25 };
    const before = { x: 280 + 580 - start.scrollX, y: 60 + 420 - start.scrollY };
    const zoomed = zoomViewport(start, area, 1.5);
    expect(zoomed.zoom).toBe(1.5);
    const after = onScreen(zoomed, before.x, before.y);
    expect(after.x).toBeCloseTo(860);
    expect(after.y).toBeCloseTo(480);
    expect(zoomViewport(start, area, 0.01).zoom).toBe(0.1);
    expect(zoomViewport(start, area, 99).zoom).toBe(30);
  });
});

describe("the controls' state", () => {
  test("reads the tool, lock, zoom and selection, and names tools as the island does", () => {
    const ui = canvasUiFrom({ activeTool: { type: "freedraw", locked: true }, zoom: { value: 0.8 }, selectedElementIds: { a: true } });
    expect(ui).toEqual({ tool: "freedraw", locked: true, zoom: 0.8, selected: true, single: "a", elementMenu: null });
    expect(islandTool("freedraw")).toBe("draw");
    expect(islandTool("selection")).toBe("select");
    expect(islandTool("frame")).toBe("frame");
    expect(nativeTool("select")).toBe("selection");
    expect(nativeTool("rectangle")).toBe("rectangle");
  });

  test("tells listeners only about real changes", () => {
    const store = createCanvasUiStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    const first = store.get();
    store.set({ ...first });
    expect(calls).toBe(0);
    expect(store.get()).toBe(first);
    store.set({ ...first, zoom: 2 });
    expect(calls).toBe(1);
    expect(store.get().zoom).toBe(2);
  });
});

describe("comments on elements", () => {
  const base = { activeTool: { type: "selection", locked: false }, zoom: { value: 1 } };

  test("one element selected is the one Comment is for; several, or none, is none", () => {
    expect(canvasUiFrom({ ...base, selectedElementIds: { a: true } }).single).toBe("a");
    expect(canvasUiFrom({ ...base, selectedElementIds: { a: true, b: true } }).single).toBeNull();
    expect(canvasUiFrom({ ...base, selectedElementIds: {} }).single).toBeNull();
  });

  test("Excalidraw's menu for an element is told apart from the canvas's", () => {
    const element = { left: 40, top: 60, items: ["separator", { name: "cut" }, { name: "copy" }] };
    const canvas = { left: 40, top: 60, items: [{ name: "paste" }, { name: "copyAsPng" }] };
    expect(canvasUiFrom({ ...base, selectedElementIds: { a: true }, contextMenu: element }).elementMenu).toEqual({ left: 40, top: 60 });
    expect(canvasUiFrom({ ...base, selectedElementIds: {}, contextMenu: canvas }).elementMenu).toBeNull();
    expect(canvasUiFrom({ ...base, selectedElementIds: {}, contextMenu: null }).elementMenu).toBeNull();
  });

  const box = { x: 100, y: 50, width: 200, height: 100 };

  test("a pin marks an element's top-right corner, or its spot, and turns with it", () => {
    expect(pinScenePoint(box)).toEqual({ x: 300, y: 50 });
    expect(pinScenePoint(box, { x: 0.25, y: 0.5 })).toEqual({ x: 150, y: 100 });
    // Turned a quarter clockwise about its middle (200, 100): the top-right corner goes to the bottom right.
    const turned = pinScenePoint({ ...box, angle: Math.PI / 2 });
    expect(turned.x).toBeCloseTo(250);
    expect(turned.y).toBeCloseTo(200);
    // A line's box is the one around its points.
    expect(pinScenePoint({ x: 10, y: 10, width: 0, height: 0, points: [[0, 0], [-20, 40]] })).toEqual({ x: 10, y: 10 });
  });

  test("a spot on an element is kept as fractions of its box, found again after it moves or turns", () => {
    expect(elementPoint(box, { x: 150, y: 100 })).toEqual({ x: 0.25, y: 0.5 });
    expect(elementPoint(box, { x: 99, y: 100 })).toBeNull();
    const turned = { ...box, angle: 0.6 };
    const spot = pinScenePoint(turned, { x: 0.3, y: 0.8 });
    expect(elementPoint(turned, spot)).toEqual({ x: 0.3, y: 0.8 });
    const moved = { ...turned, x: 400 };
    const after = pinScenePoint(moved, { x: 0.3, y: 0.8 });
    expect(after.x - spot.x).toBeCloseTo(300);
    expect(after.y).toBeCloseTo(spot.y);
  });

  test("scene points go to the screen and back through the viewport", () => {
    const view: CanvasViewport = { zoom: 2, scrollX: -50, scrollY: 10 };
    expect(sceneToCanvas({ x: 100, y: 20 }, view)).toEqual({ x: 100, y: 60 });
    expect(canvasToScene({ x: 100, y: 60 }, view)).toEqual({ x: 100, y: 20 });
    const centred = centreOn(view, area, { x: 300, y: 400 });
    expect(sceneToCanvas({ x: 300, y: 400 }, centred)).toEqual({ x: 280 + 580, y: 60 + 420 });
    expect(centred.zoom).toBe(2);
  });
});
