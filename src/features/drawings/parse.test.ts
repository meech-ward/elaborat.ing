import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDrawingFile, serializeDrawing } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const obsidianJsonSource = readFileSync(
  join(fixtureDir, 'obsidian-json.excalidraw.md'),
  'utf8',
);
const syntheticSource = readFileSync(join(fixtureDir, 'synthetic.excalidraw.md'), 'utf8');

describe('parseDrawingFile', () => {
  test('a compressed Obsidian drawing parses with all elements active', () => {
    const parsed = parseDrawingFile(syntheticSource, 'synthetic.excalidraw.md');
    expect(parsed.sourceKind).toBe('obsidian-compressed');
    expect(parsed.originalSource).toBe(syntheticSource);
    expect(parsed.scene.elements).toHaveLength(40);
    expect(parsed.scene.elements.filter((element) => element.isDeleted !== false)).toEqual([]);
    expect(parsed.scene.elements.find((element) => element.id === 'synthetic-title')).toMatchObject({
      type: 'text',
      text: 'Example system',
      containerId: null,
    });
    expect(parsed.scene.source).toBe('https://github.com/zsviczian/obsidian-excalidraw-plugin');
  });

  test('a large scene parses as ordinary JSON', () => {
    const { scene } = parseDrawingFile(syntheticSource, 'synthetic.excalidraw.md');
    // Fifty side-by-side copies of the synthetic drawing: 2,000 elements.
    const elements = Array.from({ length: 50 }, (_, copy) =>
      scene.elements.map((element) => ({
        ...element,
        id: `${element.id}-${copy}`,
        x: element.x + copy * 1300,
      })),
    ).flat();
    const parsed = parseDrawingFile(serializeDrawing({ ...scene, elements }), 'large.excalidraw');
    expect(parsed.sourceKind).toBe('excalidraw-json');
    expect(parsed.scene.elements).toHaveLength(2000);
    expect(parsed.scene.elements[0]?.id).toBe('synthetic-title-0');
    expect(parsed.scene.elements[1999]?.id).toBe(`${scene.elements[39]?.id}-49`);
    expect(parsed.scene.elements[1999]?.x).toBe((scene.elements[39]?.x ?? 0) + 49 * 1300);
  });

  test('plain-JSON Obsidian fence parses', () => {
    const parsed = parseDrawingFile(obsidianJsonSource, 'plain.excalidraw.md');
    expect(parsed.sourceKind).toBe('obsidian-json');
    expect(parsed.scene.elements).toHaveLength(1);
    expect(parsed.scene.elements[0]?.id).toBe('plain-rect');
  });

  test('malformed inputs fail with clear messages', () => {
    expect(() => parseDrawingFile('', 'empty.md')).toThrow(/empty/);
    expect(() => parseDrawingFile('just prose, no fence', 'prose.md')).toThrow(
      /no drawing fence/,
    );
    expect(() => parseDrawingFile('{"a": 1}', 'shapeless.json')).toThrow(/elements/);
    expect(() => parseDrawingFile('{"elements": {}}', 'bad.json')).toThrow(/elements/);
    expect(() => parseDrawingFile('{"type": "mermaid", "elements": []}')).toThrow(
      /unsupported drawing type/,
    );
    expect(() => parseDrawingFile('{"elements": [{"type": "rectangle"}]}')).toThrow(
      /index 0.*no usable string id/,
    );
    expect(() =>
      parseDrawingFile('{"elements": [{"id": "x", "type": "rectangle"}]}'),
    ).toThrow(/index 0.*non-numeric/);
    expect(() =>
      parseDrawingFile('```compressed-json\n!!!not-base64!!!\n```\n', 'bad.md'),
    ).toThrow(/could not decompress|not valid JSON/);
    expect(() => parseDrawingFile('```json\n\n```\n', 'empty-fence.md')).toThrow(
      /fence is empty/,
    );
  });

  test('filename appears in errors when provided', () => {
    expect(() => parseDrawingFile('', 'my-drawing.excalidraw.md')).toThrow(
      /my-drawing\.excalidraw\.md/,
    );
  });
});
