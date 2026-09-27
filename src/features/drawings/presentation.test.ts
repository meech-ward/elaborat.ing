import { describe, expect, test } from 'bun:test';
import { palettes } from '../appearance/palettes';
import { beforeDarkFilter, presentDrawing, throughDarkFilter } from './presentation.ts';
import type { DrawingScene } from './types.ts';

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

describe('beforeDarkFilter', () => {
  test("the dark canvas shows every palette's canvas and diagram colours within 3 per channel", () => {
    const misses: string[] = [];
    for (const palette of palettes) {
      for (const key of ['bg', 'ink', 'inkSoft', 'd2Fill', 'd2Fill2'] as const) {
        const want = palette.dark[key];
        const stored = beforeDarkFilter(want);
        expect(stored).toMatch(/^#[\da-f]{6}$/);
        const shown = channels(throughDarkFilter(stored));
        const miss = Math.max(...channels(want).map((value, index) => Math.abs(value - shown[index])));
        if (miss > 3) misses.push(`${palette.id} ${key} ${want} is off by ${miss}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe('presentDrawing', () => {
  const colors = { background: '#fbf7f5', stroke: '#211a1c' };
  const scene = (appState?: Record<string, unknown>): DrawingScene => ({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, strokeColor: '#1e1e1e' }],
    ...(appState ? { appState } : {}),
  });

  test("shows the palette's background over Excalidraw's default white, or none", () => {
    for (const appState of [undefined, { viewBackgroundColor: '#ffffff' }, { viewBackgroundColor: '#FFF' }]) {
      expect(presentDrawing(scene(appState), colors).appState).toMatchObject({ viewBackgroundColor: colors.background, currentItemStrokeColor: colors.stroke });
    }
  });

  test('keeps a background the file sets, and never changes the scene or its elements', () => {
    const own = scene({ viewBackgroundColor: '#fff3bf', gridSize: 20 });
    const before = structuredClone(own);
    const shown = presentDrawing(own, colors);
    expect(shown.appState).toEqual({ viewBackgroundColor: '#fff3bf', gridSize: 20, currentItemStrokeColor: colors.stroke });
    expect(shown.elements).toBe(own.elements);
    expect(own).toEqual(before);
  });
});
