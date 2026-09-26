import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffDrawingScenes,
  durableAppState,
  fingerprintScene,
  parseDrawingFile,
  saveDrawingFile,
  scenesEqual,
  serializeDrawing,
  type DrawingScene,
} from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const demoSource = readFileSync(join(fixtureDir, 'demo.scene.json'), 'utf8');
const obsidianJsonSource = readFileSync(join(fixtureDir, 'obsidian-json.excalidraw.md'), 'utf8');

function demoScene(): DrawingScene {
  return parseDrawingFile(demoSource, 'demo.scene.json').scene;
}

describe('serializeDrawing', () => {
  test('demo scene round-trips losslessly, including geometry extras', () => {
    const scene = demoScene();
    const reparsed = parseDrawingFile(serializeDrawing(scene)).scene;
    expect(scenesEqual(scene, reparsed)).toBe(true);

    const freedraw = reparsed.elements.find((element) => element.id === 'demo-freedraw-1');
    expect(freedraw?.['points']).toEqual([
      [0, 0],
      [10, 12],
      [24, 20],
      [40, 22],
    ]);
    expect(freedraw?.['pressures']).toEqual([0.5, 0.7, 0.9, 0.4]);
    expect(freedraw?.['customData']).toEqual({ author: 'demo-author', note: 'freehand annotation' });

    const pluginRect = reparsed.elements.find((element) => element.id === 'demo-plugin-rect');
    expect(pluginRect?.['myPlugin']).toEqual({ tag: 'keep-me', v: 3 });

    expect(reparsed.files?.['demo-file-1']?.['dataURL']).toContain('data:image/png;base64,');
  });

  test.todo('a compressed Obsidian scene survives serialize with all ids and native shape (held back until the synthetic Obsidian drawing lands: roadmap phase 2 step 2)', () => {});

  test('unknown top-level fields ride along in extra', () => {
    const parsed = parseDrawingFile('{"elements": [], "mystery": {"a": 1}}');
    expect(parsed.scene.extra).toEqual({ mystery: { a: 1 } });
    expect(JSON.parse(serializeDrawing(parsed.scene))['mystery']).toEqual({ a: 1 });
  });

  test('invalid scenes fail loudly', () => {
    expect(() => serializeDrawing({} as DrawingScene)).toThrow(/invalid scene/);
  });
});

describe('saveDrawingFile', () => {
  test.todo('no-op reopen of a compressed Obsidian drawing returns the original source byte-identically (held back until the synthetic Obsidian drawing lands: roadmap phase 2 step 2)', () => {});

  test('an edit returns canonical JSON plus a field-level diff', () => {
    const parsed = parseDrawingFile(demoSource, 'demo.scene.json');
    const next: DrawingScene = {
      ...parsed.scene,
      elements: parsed.scene.elements.map((element) =>
        element.id === 'demo-rect-1' ? { ...element, x: 5 } : element,
      ),
    };
    const saved = saveDrawingFile(next, parsed);
    expect(saved.noop).toBe(false);
    expect(saved.diff?.empty).toBe(false);
    expect(saved.diff?.changedElements).toContainEqual({
      id: 'demo-rect-1',
      field: 'x',
      before: 0,
      after: 5,
    });
    expect(JSON.parse(saved.text)['type']).toBe('excalidraw');
  });

  test('volatile-only metadata is not an authored change', () => {
    const scene = demoScene();
    const touched: DrawingScene = {
      ...scene,
      elements: scene.elements.map((element) => ({
        ...element,
        updated: 999999,
        versionNonce: 123456789,
      })),
    };
    expect(scenesEqual(scene, touched)).toBe(false);
    expect(fingerprintScene(scene)).toBe(fingerprintScene(touched));
    expect(diffDrawingScenes(scene, touched).empty).toBe(true);
  });

  test('durable background changes dirty the scene; scroll never does', () => {
    const scene = demoScene();
    expect(durableAppState(scene.appState)).toEqual({
      theme: 'light',
      viewBackgroundColor: 'transparent',
    });
    const scrolled: DrawingScene = {
      ...scene,
      appState: { ...(scene.appState ?? {}), scrollX: -9999, scrollY: 4242, zoom: { value: 3 } },
    };
    expect(fingerprintScene(scrolled)).toBe(fingerprintScene(scene));
    expect(diffDrawingScenes(scene, scrolled).empty).toBe(true);
    const tinted: DrawingScene = {
      ...scene,
      appState: { ...(scene.appState ?? {}), viewBackgroundColor: '#000000' },
    };
    expect(fingerprintScene(tinted)).not.toBe(fingerprintScene(scene));
    expect(saveDrawingFile(tinted, parseDrawingFile(demoSource)).noop).toBe(false);
    expect(saveDrawingFile(scrolled, parseDrawingFile(demoSource)).noop).toBe(true);
  });

  test.todo('an edited compressed Obsidian wrapper keeps its markdown and parses back to the edit (held back until the synthetic Obsidian drawing lands: roadmap phase 2 step 2)', () => {});

  test('an edited plain-JSON fence keeps its wrapper and parses back', () => {
    const parsed = parseDrawingFile(obsidianJsonSource, 'plain.excalidraw.md');
    expect(parsed.sourceKind).toBe('obsidian-json');
    const next: DrawingScene = {
      ...parsed.scene,
      elements: parsed.scene.elements.map((element) => ({ ...element, y: 99 })),
    };
    const saved = saveDrawingFile(next, parsed);
    expect(saved.noop).toBe(false);
    expect(saved.text).toContain('```json');
    expect(saved.text).toContain('# Plain JSON drawing');
    const reparsed = parseDrawingFile(saved.text, 'plain.excalidraw.md');
    expect(scenesEqual(reparsed.scene, next)).toBe(true);
  });

  test('added, removed, appState and file changes are reported', () => {
    const scene = demoScene();
    const next: DrawingScene = {
      ...scene,
      elements: [
        ...scene.elements.filter((element) => element.id !== 'demo-note'),
        { id: 'demo-new', type: 'rectangle', x: 1, y: 2 },
      ],
      appState: { ...(scene.appState ?? {}), theme: 'dark' },
      files: {},
    };
    const diff = diffDrawingScenes(scene, next);
    expect(diff.empty).toBe(false);
    expect(diff.addedElementIds).toEqual(['demo-new']);
    expect(diff.removedElementIds).toEqual(['demo-note']);
    expect(diff.appStateChanged).toBe(true);
    expect(diff.filesChanged).toEqual(['demo-file-1']);
    expect(diff.truncated).toBe(false);
  });
});
