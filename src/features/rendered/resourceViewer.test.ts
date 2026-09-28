/**
 * Unit tests for the reading-only resource viewer logic.
 *
 * The viewer never edits files: zoom/pan state is local view state only.
 * Scale stays within explicit bounds so touch controls cannot lose the
 * image; Fit returns to the initial fitted view.
 */
import { describe, expect, test } from 'bun:test';
import {
  INITIAL_VIEW,
  MAX_VIEW_SCALE,
  MIN_VIEW_SCALE,
  fitView,
  fitWidthView,
  stepViewScale,
  clampViewScale,
  scaleViewAt,
  pictureSize,
} from './resourceViewer.ts';

test('reading-width opening enlarges tall drawings and starts at their top', () => {
  expect(fitWidthView(1200, 600, 0.5)).toEqual({ scale: 4, x: 0, y: 900 });
  expect(fitWidthView(1200, 600, 3)).toEqual(fitView());
  expect(fitWidthView(0, 0, 1)).toEqual(fitView());
  const longDrawing = fitWidthView(1200, 600, 0.1);
  expect(longDrawing.scale).toBe(20);
  expect(stepViewScale(longDrawing.scale, 'in', longDrawing.scale * MAX_VIEW_SCALE)).toBe(25);
});

describe('resourceViewer scale bounds', () => {
  test('clamps below the minimum and above the maximum', () => {
    expect(clampViewScale(0)).toBe(MIN_VIEW_SCALE);
    expect(clampViewScale(0.01)).toBe(MIN_VIEW_SCALE);
    expect(clampViewScale(999)).toBe(MAX_VIEW_SCALE);
    expect(clampViewScale(Number.NaN)).toBe(INITIAL_VIEW.scale);
  });

  test('keeps in-range scales untouched', () => {
    expect(clampViewScale(1)).toBe(1);
    expect(clampViewScale(MIN_VIEW_SCALE)).toBe(MIN_VIEW_SCALE);
    expect(clampViewScale(MAX_VIEW_SCALE)).toBe(MAX_VIEW_SCALE);
  });

  test('zoom steps stay inside the bounds', () => {
    expect(stepViewScale(MIN_VIEW_SCALE, 'out')).toBe(MIN_VIEW_SCALE);
    expect(stepViewScale(MAX_VIEW_SCALE, 'in')).toBe(MAX_VIEW_SCALE);
    expect(stepViewScale(1, 'in')).toBeGreaterThan(1);
    expect(stepViewScale(1, 'out')).toBeLessThan(1);
    // Repeated zooming in saturates at the maximum, never beyond it.
    let scale = 1;
    for (let i = 0; i < 50; i++) scale = stepViewScale(scale, 'in');
    expect(scale).toBe(MAX_VIEW_SCALE);
  });

  test('fit returns the initial fitted view', () => {
    expect(fitView()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(INITIAL_VIEW).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('resourceViewer point stability', () => {
  test('a moved pinch midpoint keeps the same image point after prior pan', () => {
    const before = { scale: 2, x: 45, y: -20 };
    const from = { x: 80, y: 30 }, to = { x: 110, y: 50 };
    const after = scaleViewAt(before, 3, from, to);
    expect((to.x - after.x) / after.scale).toBe((from.x - before.x) / before.scale);
    expect((to.y - after.y) / after.scale).toBe((from.y - before.y) / before.scale);
  });

  test('clamped zoom uses the actual scale ratio, including midpoint pan at a bound', () => {
    const before = { scale: MAX_VIEW_SCALE, x: 45, y: -20 };
    expect(scaleViewAt(before, 100, { x: 80, y: 30 }, { x: 110, y: 50 }))
      .toEqual({ scale: MAX_VIEW_SCALE, x: 75, y: 0 });
    const small = scaleViewAt({ scale: 1, x: 20, y: 40 }, 0.01, { x: 60, y: 80 });
    expect(small).toEqual({ scale: MIN_VIEW_SCALE, x: 50, y: 70 });
  });
});

test('a picture\'s own size comes from its SVG\'s width and height, or its viewBox', () => {
  expect(pictureSize('<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 185 564" width="185" height="564"><rect/></svg>')).toEqual({ width: 185, height: 564 });
  expect(pictureSize('<svg viewBox="0 0 400.5 120"><rect width="10" height="10"/></svg>')).toEqual({ width: 400.5, height: 120 });
  expect(pictureSize('<svg width="100%" height="auto" viewBox="0 0 30 20"></svg>')).toEqual({ width: 30, height: 20 });
  expect(pictureSize('<svg><rect width="10" height="10"/></svg>')).toBeNull();
  expect(pictureSize('not a picture')).toBeNull();
});
