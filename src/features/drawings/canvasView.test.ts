import { describe, expect, test } from "bun:test";
import { FIT_MARGIN, canvasUiFrom, createCanvasUiStore, fitViewport, islandTool, nativeTool, zoomViewport, type CanvasArea, type CanvasViewport } from "./canvasView";

/** Where a scene point lands on the canvas. */
const onScreen = (view: CanvasViewport, x: number, y: number) => ({ x: (x + view.scrollX) * view.zoom, y: (y + view.scrollY) * view.zoom });

// A 1440 by 900 canvas with the side panel's 280 and the top line's 60 covering it.
const area: CanvasArea = { left: 280, top: 60, width: 1160, height: 840 };

describe("fitViewport", () => {
  test("centres a small scene in the visible area at 100%", () => {
    const view = fitViewport([100, 100, 300, 200], area)!;
    expect(view.zoom).toBe(1);
    expect(onScreen(view, 200, 150)).toEqual({ x: 280 + 580, y: 60 + 420 });
  });

  test("zooms out until a large scene fits inside the margins, still centred", () => {
    const view = fitViewport([0, 0, 2000, 500], area)!;
    expect(view.zoom).toBeCloseTo((1160 - 2 * FIT_MARGIN.x) / 2000);
    const left = onScreen(view, 0, 0);
    const right = onScreen(view, 2000, 500);
    expect(left.x).toBeCloseTo(280 + FIT_MARGIN.x);
    expect(right.x).toBeCloseTo(280 + 1160 - FIT_MARGIN.x);
    expect((left.y + right.y) / 2).toBeCloseTo(60 + 420);
  });

  test("has nothing to fit into when the canvas is hidden", () => {
    expect(fitViewport([0, 0, 10, 10], { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
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
