import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportDrawingPng,
  exportDrawingSvg,
  parseDrawingFile,
  summarizeDrawing,
  type DrawingScene,
} from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const demoSource = readFileSync(join(fixtureDir, 'demo.scene.json'), 'utf8');
const syntheticSource = readFileSync(join(fixtureDir, 'synthetic.excalidraw.md'), 'utf8');

function demoScene(): DrawingScene {
  return parseDrawingFile(demoSource, 'demo.scene.json').scene;
}

describe('summarizeDrawing', () => {
  test('demo scene reports raw facts without interpretation', () => {
    const summary = summarizeDrawing(demoScene());
    expect(summary.elementCount).toBe(12);
    expect(summary.activeCount).toBe(11);
    expect(summary.deletedCount).toBe(1);
    expect(summary.byType).toMatchObject({
      rectangle: 4,
      text: 2,
      arrow: 2,
      freedraw: 1,
      ellipse: 2,
      image: 1,
    });
    expect(summary.texts).toEqual([
      { id: 'demo-text-1', text: 'hello' },
      { id: 'demo-note', text: 'loose note' },
    ]);
    expect(summary.bounds).toEqual({ x: 0, y: 0, width: 750, height: 400 });
    expect(summary.arrows).toHaveLength(2);
    expect(summary.arrows.find((arrow) => arrow.id === 'demo-arrow-1')).toMatchObject({
      startElementId: 'demo-rect-1',
      endElementId: 'demo-rect-2',
      bound: 'both',
      dangling: false,
    });
    expect(summary.looseArrows).toEqual(['demo-loose-arrow']);
    expect(summary.danglingArrows).toEqual([]);
    expect(summary.groupIds).toEqual(['demo-group-1']);
    expect(summary.imageIds).toEqual(['demo-file-1']);
    expect(summary.hasImages).toBe(true);
    expect(summary.customDataElementIds).toEqual(['demo-freedraw-1']);
    expect(summary.strokeColors).toContain('#e03131');
  });

  test('loose arrows are preserved annotations, dangling arrows are flagged', () => {
    const scene = demoScene();
    const cut = scene.elements.find((element) => element.id === 'demo-rect-2');
    expect(cut).toBeDefined();
    const summary = summarizeDrawing({
      ...scene,
      elements: scene.elements.filter((element) => element.id !== 'demo-rect-2'),
    });
    expect(summary.danglingArrows).toEqual(['demo-arrow-1']);
    expect(summary.looseArrows).toEqual(['demo-loose-arrow']);
  });

  test('a compressed Obsidian scene summarizes its active elements and texts', () => {
    const summary = summarizeDrawing(
      parseDrawingFile(syntheticSource, 'synthetic.excalidraw.md').scene,
    );
    expect(summary.elementCount).toBe(40);
    expect(summary.activeCount).toBe(40);
    expect(summary.deletedCount).toBe(0);
    expect(summary.byType).toEqual({
      text: 17,
      ellipse: 1,
      rectangle: 10,
      diamond: 1,
      arrow: 10,
      line: 1,
    });
    expect(summary.texts[0]).toEqual({ id: 'synthetic-title', text: 'Example system' });
    expect(summary.texts.map((text) => text.text)).toEqual([
      'Example system',
      'User',
      'Browser',
      'CDN',
      'Web app',
      'Cache',
      'API',
      'Auth',
      'Database',
      'Queue',
      'Worker',
      'Storage',
      'Healthy?',
      'HTTPS',
      'jobs',
      'Arrows point the way requests travel.',
      'Every name here is made up.',
    ]);
    expect(summary.bounds).toEqual({ x: 40, y: 20, width: 1220, height: 605 });
    expect(summary.arrows).toHaveLength(10);
    expect(summary.arrows.filter((arrow) => arrow.bound !== 'both' || arrow.dangling)).toEqual([]);
    expect(summary.looseArrows).toEqual([]);
    expect(summary.danglingArrows).toEqual([]);
    expect(summary.backgroundColors).toEqual(['#a5d8ff', '#b2f2bb', '#ffec99', 'transparent']);
    expect(summary.hasImages).toBe(false);
  });

  test('empty scene summarizes safely', () => {
    const summary = summarizeDrawing({ type: 'excalidraw', version: 2, elements: [] });
    expect(summary.bounds).toBeNull();
    expect(summary.hasImages).toBe(false);
    expect(summary.arrows).toEqual([]);
  });
});

describe('native export failure contract', () => {
  test('SVG/PNG export rejects clearly without a browser bundle', async () => {
    const scene = demoScene();
    await expect(exportDrawingSvg(scene)).rejects.toThrow(/excalidraw/i);
    await expect(exportDrawingPng(scene)).rejects.toThrow(/excalidraw/i);
  });

  test('empty scenes and bad scales fail before touching the DOM', async () => {
    const empty: DrawingScene = { type: 'excalidraw', version: 2, elements: [] };
    await expect(exportDrawingSvg(empty)).rejects.toThrow(/empty drawing/);
    await expect(exportDrawingPng(demoScene(), { scale: 0 })).rejects.toThrow(
      /invalid export scale/,
    );
  });
});
