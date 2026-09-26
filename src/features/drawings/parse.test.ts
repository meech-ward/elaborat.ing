import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDrawingFile } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures');
const obsidianJsonSource = readFileSync(
  join(fixtureDir, 'obsidian-json.excalidraw.md'),
  'utf8',
);

describe('parseDrawingFile', () => {
  test.todo('a compressed Obsidian drawing parses with all elements active (held back until the synthetic Obsidian drawing lands: roadmap phase 2 step 2)', () => {});

  test.todo('a large scene parses as ordinary JSON (held back until the synthetic Obsidian drawing lands: roadmap phase 2 step 2)', () => {});

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
