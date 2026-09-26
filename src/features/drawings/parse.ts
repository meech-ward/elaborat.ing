// Strict parsing for native drawing files.
//
// Accepted inputs:
//   - ordinary .excalidraw JSON: {"type":"excalidraw","version":2,...}
//   - bare scene JSON with just {elements, appState} (agent checkpoints)
//   - Obsidian .excalidraw.md: a ```compressed-json lz-string fence
//   - Obsidian plain-JSON variant: a ```json fence holding the same payload
//
// Everything unknown is preserved (elements keep all their fields,
// unknown top-level keys land in scene.extra). Nothing is normalized:
// loose arrows, overlapping strokes, groups and customData survive.
// Failures throw plain Errors with actionable messages.

import { z } from 'zod';
import LZString from 'lz-string';
import type {
  BinaryFileData,
  DrawingElement,
  DrawingScene,
  DrawingSourceKind,
  ParsedDrawing,
} from './types.ts';

const elementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    x: z.number(),
    y: z.number(),
  })
  .catchall(z.unknown());

const sceneSchema = z
  .object({
    type: z.literal('excalidraw').optional(),
    version: z.number().optional(),
    elements: z.array(z.unknown()),
    appState: z.record(z.string(), z.unknown()).optional(),
    files: z.record(z.string(), z.unknown()).optional(),
    source: z.string().optional(),
  })
  .catchall(z.unknown());

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'type',
  'version',
  'elements',
  'appState',
  'files',
  'source',
]);

/**
 * Fence locating the drawing payload inside an Obsidian markdown wrapper.
 * Exported for saveDrawingFile, which splices a replacement payload into
 * the same fence while preserving every other markdown byte.
 */
export const DRAWING_FENCE_RE = /```(compressed-json|json)\s*\n([\s\S]*?)```/;

const FENCE_RE = DRAWING_FENCE_RE;

function fail(what: string, filename?: string): never {
  throw new Error(
    filename ? `invalid drawing ${filename}: ${what}` : `invalid drawing: ${what}`,
  );
}

function checkJsonObject(value: unknown, filename?: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('top-level JSON must be an object with an elements array', filename);
  }
  return value as Record<string, unknown>;
}

function parseJsonPayload(text: string, origin: string, filename?: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${origin} is not valid JSON: ${detail}`, filename);
  }
}

function describeIssue(issue: z.core.$ZodIssue, elementCount: number): string {
  const path = issue.path.map(String);
  if (path[0] === 'elements' && typeof path[1] === 'string') {
    const index = Number(path[1]);
    const field = path[2];
    if (field === 'id') {
      return `element at index ${index} has no usable string id`;
    }
    if (field === 'type') {
      return `element at index ${index} has no usable string type`;
    }
    if (field === 'x' || field === 'y') {
      return `element at index ${index} has a non-numeric ${field}`;
    }
    return `element at index ${index} is invalid: ${issue.message}`;
  }
  if (path[0] === 'elements' && path.length === 1) {
    return `elements must be an array (scene holds ${elementCount} top-level keys, none usable)`;
  }
  if (path[0] === 'type') {
    return `unsupported drawing type (expected "excalidraw" when present)`;
  }
  return `${path.join('.') || 'drawing'}: ${issue.message}`;
}

function toScene(
  raw: Record<string, unknown>,
  sourceKind: DrawingSourceKind,
  originalSource: string,
  filename?: string,
): ParsedDrawing {
  const parsed = sceneSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    fail(
      describeIssue(first, Object.keys(raw).length),
      filename,
    );
  }
  const data = parsed.data as Record<string, unknown>;

  const rawElements = data['elements'] as unknown[];
  const elements: DrawingElement[] = rawElements.map((entry, index) => {
    const checked = elementSchema.safeParse(entry);
    if (!checked.success) {
      const first = checked.error.issues[0];
      const field = String(first.path[0] ?? '');
      if (field === 'id') {
        fail(`element at index ${index} has no usable string id`, filename);
      }
      if (field === 'type') {
        fail(`element at index ${index} has no usable string type`, filename);
      }
      if (field === 'x' || field === 'y') {
        fail(`element at index ${index} has a non-numeric ${field}`, filename);
      }
      fail(`element at index ${index} is invalid: ${first.message}`, filename);
    }
    return checked.data as DrawingElement;
  });

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      extra[key] = value;
    }
  }

  const scene: DrawingScene = {
    type: 'excalidraw',
    version: typeof data['version'] === 'number' ? data['version'] : 2,
    elements,
  };
  if (data['appState'] !== undefined) {
    scene.appState = data['appState'] as Record<string, unknown>;
  }
  if (data['files'] !== undefined) {
    scene.files = data['files'] as Record<string, BinaryFileData>;
  }
  if (typeof data['source'] === 'string') {
    scene.source = data['source'];
  }
  if (Object.keys(extra).length > 0) {
    scene.extra = extra;
  }
  return { scene, sourceKind, originalSource };
}

/**
 * Parse one drawing file. Returns the scene plus the exact input text so
 * the shell can preserve it byte-identically on a no-op save.
 * Throws a descriptive Error for empty, non-JSON, unfenced, undecodable
 * or shapeless input; never returns a normalized or partial scene.
 */
export function parseDrawingFile(source: string, filename?: string): ParsedDrawing {
  if (typeof source !== 'string' || source.trim().length === 0) {
    fail('file is empty', filename);
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('{')) {
    const raw = checkJsonObject(
      parseJsonPayload(trimmed, 'drawing file', filename),
      filename,
    );
    return toScene(raw, 'excalidraw-json', source, filename);
  }

  const fence = trimmed.match(FENCE_RE);
  if (!fence) {
    fail(
      'no drawing fence found (expected a ```compressed-json or ```json fenced block)',
      filename,
    );
  }
  const [, language, payload] = fence;
  if (language === 'compressed-json') {
    const compact = payload.replace(/\s+/g, '');
    if (compact.length === 0) {
      fail('```compressed-json fence is empty', filename);
    }
    let decompressed: string | null = null;
    try {
      decompressed = LZString.decompressFromBase64(compact);
    } catch {
      decompressed = null;
    }
    if (typeof decompressed !== 'string' || decompressed.length === 0) {
      fail(
        'could not decompress the ```compressed-json payload (expected lz-string base64)',
        filename,
      );
    }
    const raw = checkJsonObject(
      parseJsonPayload(decompressed, 'decompressed drawing', filename),
      filename,
    );
    return toScene(raw, 'obsidian-compressed', source, filename);
  }
  if (payload.trim().length === 0) {
    fail('```json fence is empty', filename);
  }
  const raw = checkJsonObject(
    parseJsonPayload(payload, '```json drawing fence', filename),
    filename,
  );
  return toScene(raw, 'obsidian-json', source, filename);
}
