import { describe, expect, test } from "bun:test";
import { canvasUiFrom, createCanvasUiStore, followArea, islandTool, nativeTool, openingViewport, zoomViewport, type CanvasArea, type CanvasViewport } from "./canvasView";

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

  test("opens a scene larger than the area at 100% too, its middle in the middle", () => {
    const view = openingViewport([0, 0, 2000, 1500], area)!;
    expect(view.zoom).toBe(1);
    expect(onScreen(view, 1000, 750)).toEqual({ x: 280 + 580, y: 60 + 420 });
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
    expect(ui).toEqual({ tool: "freedraw", locked: true, zoom: 0.8, selected: true });
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
