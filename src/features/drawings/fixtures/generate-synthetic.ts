// Writes synthetic.excalidraw.md next to this file: a made-up system diagram
// in Obsidian's Excalidraw format, for the drawing tests. The compressed fence
// is the repo's own serializeDrawing output through lz-string, so parsing the
// file and serializing it again reproduces the fence byte for byte. Ids and
// seeds come from a fixed-seed generator, so every run writes the same file.
//
// Run from the repository root:
//   bun src/features/drawings/fixtures/generate-synthetic.ts

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import LZString from 'lz-string';
import { serializeDrawing } from '../serialize.ts';
import type { DrawingElement, DrawingScene } from '../types.ts';

/** mulberry32: a small fixed-seed generator. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(20260926);
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const INDEX_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const UPDATED = 1767225600000;

function randomId(): string {
  let id = '';
  for (let index = 0; index < 20; index += 1) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

function randomInt(): number {
  return Math.floor(random() * 2 ** 31);
}

const elements: DrawingElement[] = [];

/** Adds an element with Excalidraw's common fields, in canvas order. */
function add(
  type: string,
  box: { x: number; y: number; width: number; height: number },
  fields: Record<string, unknown>,
  id = randomId(),
): DrawingElement {
  const element: DrawingElement = {
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${INDEX_DIGITS[elements.length]}`,
    roundness: null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: [],
    updated: UPDATED,
    link: null,
    locked: false,
    ...fields,
  };
  elements.push(element);
  return element;
}

function textFields(text: string, fontSize: number, containerId: string | null) {
  return {
    text,
    fontSize,
    fontFamily: 5,
    textAlign: containerId === null ? 'left' : 'center',
    verticalAlign: containerId === null ? 'top' : 'middle',
    containerId,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function textSize(text: string, fontSize: number) {
  return { width: Math.round(text.length * fontSize * 0.55), height: fontSize * 1.25 };
}

/** Free text, not bound to anything. */
function freeText(x: number, y: number, text: string, fontSize = 20, id?: string) {
  return add('text', { x, y, ...textSize(text, fontSize) }, textFields(text, fontSize, null), id);
}

/** Text centered in a container, bound to it both ways. */
function label(container: DrawingElement, text: string, center?: { x: number; y: number }) {
  const size = textSize(text, 20);
  const middle = center ?? {
    x: container.x + Number(container['width']) / 2,
    y: container.y + Number(container['height']) / 2,
  };
  const element = add(
    'text',
    { x: middle.x - size.width / 2, y: middle.y - size.height / 2, ...size },
    textFields(text, 20, container.id),
  );
  (container['boundElements'] as unknown[]).push({ type: 'text', id: element.id });
  return element;
}

function shape(type: string, x: number, y: number, text: string, backgroundColor: string) {
  const box =
    type === 'rectangle'
      ? { x, y, width: 160, height: 70 }
      : { x, y, width: 140, height: type === 'diamond' ? 100 : 70 };
  const element = add(type, box, {
    backgroundColor,
    roundness: type === 'rectangle' ? { type: 3 } : { type: 2 },
  });
  label(element, text);
  return element;
}

/** An arrow bound at both ends, from one shape's edge to the other's. */
function arrow(from: DrawingElement, to: DrawingElement, text?: string) {
  const gap = 8;
  const size = (element: DrawingElement) => ({
    width: Number(element['width']),
    height: Number(element['height']),
  });
  const a = size(from);
  const b = size(to);
  const dx = to.x + b.width / 2 - (from.x + a.width / 2);
  const dy = to.y + b.height / 2 - (from.y + a.height / 2);
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  if (Math.abs(dx) >= Math.abs(dy)) {
    start = { x: dx > 0 ? from.x + a.width + gap : from.x - gap, y: from.y + a.height / 2 };
    end = { x: dx > 0 ? to.x - gap : to.x + b.width + gap, y: to.y + b.height / 2 };
  } else {
    start = { x: from.x + a.width / 2, y: dy > 0 ? from.y + a.height + gap : from.y - gap };
    end = { x: to.x + b.width / 2, y: dy > 0 ? to.y - gap : to.y + b.height + gap };
  }
  const element = add(
    'arrow',
    {
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    },
    {
      roundness: { type: 2 },
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap },
      endBinding: { elementId: to.id, focus: 0, gap },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    },
  );
  for (const bound of [from, to]) {
    (bound['boundElements'] as unknown[]).push({ type: 'arrow', id: element.id });
  }
  if (text !== undefined) {
    label(element, text, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  }
  return element;
}

const CLIENT = '#a5d8ff';
const SERVER = '#b2f2bb';
const DATA = '#ffec99';

freeText(40, 20, 'Example system', 28, 'synthetic-title');
const user = shape('ellipse', 40, 100, 'User', 'transparent');
const browser = shape('rectangle', 220, 100, 'Browser', CLIENT);
const cdn = shape('rectangle', 440, 100, 'CDN', CLIENT);
const web = shape('rectangle', 660, 100, 'Web app', CLIENT);
const cache = shape('rectangle', 440, 260, 'Cache', DATA);
const api = shape('rectangle', 660, 260, 'API', SERVER);
const auth = shape('rectangle', 880, 260, 'Auth', SERVER);
const database = shape('rectangle', 440, 420, 'Database', DATA);
const queue = shape('rectangle', 660, 420, 'Queue', SERVER);
const worker = shape('rectangle', 880, 420, 'Worker', SERVER);
const storage = shape('rectangle', 1100, 420, 'Storage', DATA);
shape('diamond', 1100, 245, 'Healthy?', 'transparent');
arrow(user, browser);
arrow(browser, cdn, 'HTTPS');
arrow(cdn, web);
arrow(web, api);
arrow(api, auth);
arrow(api, cache);
arrow(api, queue, 'jobs');
arrow(api, database);
arrow(queue, worker);
arrow(worker, storage);
add(
  'line',
  { x: 40, y: 540, width: 1220, height: 0 },
  {
    strokeStyle: 'dashed',
    points: [
      [0, 0],
      [1220, 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  },
);
freeText(40, 560, 'Arrows point the way requests travel.');
freeText(40, 600, 'Every name here is made up.');

const scene: DrawingScene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin',
  elements,
  appState: { gridSize: null, theme: 'light', viewBackgroundColor: '#ffffff' },
  files: {},
};

const textElements = elements
  .filter((element) => element.type === 'text')
  .map((element) => `${String(element['text'])} ^${element.id}`)
  .join('\n\n');

const markdown = [
  '---',
  'excalidraw-plugin: parsed',
  'tags: [excalidraw]',
  '---',
  '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==',
  '',
  '',
  '# Excalidraw Data',
  '',
  '## Text Elements',
  textElements,
  '',
  '%%',
  '## Drawing',
  '```compressed-json',
  LZString.compressToBase64(serializeDrawing(scene)),
  '```',
  '%%',
  '',
].join('\n');

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'synthetic.excalidraw.md'), markdown);
console.log(`wrote synthetic.excalidraw.md with ${elements.length} elements`);
