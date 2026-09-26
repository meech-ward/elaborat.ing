// Canonical serialization, equality, field-level diff and no-op saves.
//
// serializeDrawing emits standard native .excalidraw JSON (never an
// image-only export): deterministic for the same scene, two-space indent,
// no trailing newline. Element key order and canvas order are preserved,
// so points, pressures, groups, customData and every unknown field round
// trip byte-for-byte through parse -> serialize.
//
// A no-op reopen must not rewrite the file: saveDrawingFile returns the
// original source string verbatim when the scene is unchanged, and the
// field-level diff otherwise. Restoration noise (versionNonce/updated,
// which the native canvas regenerates on load) never counts as a change.

import { DRAWING_FENCE_RE, parseDrawingFile } from './parse.ts';
import LZString from 'lz-string';
import type {
  DrawingElement,
  DrawingScene,
  DrawingSourceKind,
  ParsedDrawing,
  SaveDrawingResult,
  SceneDiff,
} from './types.ts';
import { DURABLE_APP_STATE_KEYS } from './types.ts';

/** Native metadata regenerated on load; ignored for change detection. */
const VOLATILE_ELEMENT_KEYS = new Set(['updated', 'versionNonce']);

const MAX_CHANGED_FIELDS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic JSON: sorted object keys, arrays keep canvas order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  const text = JSON.stringify(value);
  return typeof text === 'string' ? text : 'null';
}

function stripVolatile(element: DrawingElement): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (!VOLATILE_ELEMENT_KEYS.has(key)) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * The durable subset of app state: theme and viewBackgroundColor only.
 * Scroll, zoom, selection, collaborators, hover and tool state are
 * ephemeral and excluded, so they never mark the scene dirty.
 */
export function durableAppState(appState: unknown): Record<string, unknown> {
  if (typeof appState !== 'object' || appState === null || Array.isArray(appState)) {
    return {};
  }
  const source = appState as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of DURABLE_APP_STATE_KEYS) {
    if (key in source) {
      kept[key] = source[key];
    }
  }
  return kept;
}

/**
 * Stable fingerprint of authored content: volatile-stripped elements in
 * canvas order plus files plus durable app-state prefs. Used to tell
 * restoration updates apart from real edits, and by the shell for
 * revision/hash checks. A real background change marks the scene dirty;
 * scroll/selection/hover never do.
 */
export function fingerprintScene(scene: DrawingScene): string {
  const stripped = scene.elements.map(stripVolatile);
  const files = scene.files ?? {};
  const durable = durableAppState(scene.appState);
  const payload =
    `elements:${stableStringify(stripped)}|files:${stableStringify(files)}` +
    `|durable:${stableStringify(durable)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function assertSceneShape(scene: DrawingScene): void {
  if (!isRecord(scene) || !Array.isArray((scene as { elements?: unknown }).elements)) {
    throw new Error('invalid scene: expected { type, version, elements: [] }');
  }
}

/**
 * Canonical native .excalidraw JSON for the scene. Deterministic: the same
 * scene always yields the same string. Unknown top-level fields recorded
 * in scene.extra are merged back; nothing else is dropped.
 */
export function serializeDrawing(scene: DrawingScene): string {
  assertSceneShape(scene);
  const payload: Record<string, unknown> = {
    type: 'excalidraw',
    version: scene.version,
    source: scene.source ?? 'https://excalidraw.com',
    elements: scene.elements,
  };
  if (scene.appState !== undefined) {
    payload['appState'] = scene.appState;
  }
  if (scene.files !== undefined) {
    payload['files'] = scene.files;
  }
  if (scene.extra !== undefined) {
    for (const [key, value] of Object.entries(scene.extra)) {
      if (!(key in payload)) {
        payload[key] = value;
      }
    }
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * Strict semantic equality: same elements (ordered, all fields), files,
 * version and extras. App state compares durable prefs only (theme,
 * viewBackgroundColor): ephemeral scroll/selection/zoom never count, so a
 * scroll-only difference is a no-op save.
 */
export function scenesEqual(a: DrawingScene, b: DrawingScene): boolean {
  assertSceneShape(a);
  assertSceneShape(b);
  const envelope = (scene: DrawingScene): Record<string, unknown> => ({
    type: scene.type,
    version: scene.version,
    source: scene.source ?? null,
    elements: scene.elements,
    appState: durableAppState(scene.appState),
    files: scene.files ?? {},
    extra: scene.extra ?? {},
  });
  return stableStringify(envelope(a)) === stableStringify(envelope(b));
}

function indexById(elements: DrawingElement[]): Map<string, DrawingElement> {
  const map = new Map<string, DrawingElement>();
  for (const element of elements) {
    if (!map.has(element.id)) {
      map.set(element.id, element);
    }
  }
  return map;
}

/**
 * How many elements `after` adds, removes and changes compared with `before`,
 * as a person would count them: an element deleted on the canvas (kept with
 * `isDeleted`) counts as removed, and volatile metadata is not a change.
 */
export function countElementChanges(
  before: DrawingScene,
  after: DrawingScene,
): { added: number; removed: number; changed: number } {
  assertSceneShape(before);
  assertSceneShape(after);
  const live = (scene: DrawingScene) => indexById(scene.elements.filter((element) => element.isDeleted !== true));
  const beforeById = live(before);
  const afterById = live(after);
  let added = 0;
  let changed = 0;
  for (const [id, next] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) added++;
    else if (stableStringify(stripVolatile(prev)) !== stableStringify(stripVolatile(next))) changed++;
  }
  let removed = 0;
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed++;
  }
  return { added, removed, changed };
}

/**
 * Field-level diff between two scenes. Added/removed element ids, one row
 * per changed field on surviving elements, appState and file changes.
 * Volatile metadata (updated/versionNonce) is excluded.
 */
export function diffDrawingScenes(before: DrawingScene, after: DrawingScene): SceneDiff {
  assertSceneShape(before);
  assertSceneShape(after);
  const beforeById = indexById(before.elements);
  const afterById = indexById(after.elements);

  const addedElementIds: string[] = [];
  const removedElementIds: string[] = [];
  for (const id of afterById.keys()) {
    if (!beforeById.has(id)) {
      addedElementIds.push(id);
    }
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) {
      removedElementIds.push(id);
    }
  }

  const changedElements: SceneDiff['changedElements'] = [];
  let truncated = false;
  for (const [id, next] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) {
      continue;
    }
    const prevStripped = stripVolatile(prev);
    const nextStripped = stripVolatile(next);
    const fields = new Set([...Object.keys(prevStripped), ...Object.keys(nextStripped)]);
    for (const field of fields) {
      if (stableStringify(prevStripped[field]) !== stableStringify(nextStripped[field])) {
        if (changedElements.length >= MAX_CHANGED_FIELDS) {
          truncated = true;
          break;
        }
        changedElements.push({
          id,
          field,
          before: prevStripped[field] ?? null,
          after: nextStripped[field] ?? null,
        });
      }
    }
    if (truncated) {
      break;
    }
  }

  // Durable prefs only: scroll/selection/zoom churn never reports a change.
  const appStateChanged =
    stableStringify(durableAppState(before.appState)) !==
    stableStringify(durableAppState(after.appState));

  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  const filesChanged: string[] = [];
  for (const id of new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])) {
    if (stableStringify(beforeFiles[id]) !== stableStringify(afterFiles[id])) {
      filesChanged.push(id);
    }
  }

  const empty =
    addedElementIds.length === 0 &&
    removedElementIds.length === 0 &&
    changedElements.length === 0 &&
    !appStateChanged &&
    filesChanged.length === 0;
  return {
    addedElementIds,
    removedElementIds,
    changedElements,
    appStateChanged,
    filesChanged,
    empty,
    truncated,
  };
}

/**
 * Splice an edited drawing payload back into its Obsidian markdown
 * wrapper. Only the fence payload is replaced; every other markdown byte
 * (frontmatter, headings, prose, text-element lists) is preserved. The
 * compressed fence is re-encoded with lz-string, the
 * plain-JSON fence with the canonical drawing JSON.
 */
function replaceDrawingFence(
  originalSource: string,
  drawingJson: string,
  sourceKind: DrawingSourceKind,
): string {
  const match = originalSource.match(DRAWING_FENCE_RE);
  if (!match || match.index === undefined) {
    return drawingJson;
  }
  const full = match[0];
  const header = full.slice(0, full.indexOf('\n') + 1);
  const payload =
    sourceKind === 'obsidian-compressed'
      ? `${LZString.compressToBase64(drawingJson)}\n`
      : `\n${drawingJson}\n`;
  return `${originalSource.slice(0, match.index)}${header}${payload}\`\`\`` +
    originalSource.slice(match.index + full.length);
}

/**
 * Save helper: returns the original source verbatim when the scene matches
 * it (byte-identical no-op), otherwise the canonical drawing payload plus
 * the field-level diff. An edited Obsidian wrapper keeps its markdown
 * bytes with only the fence payload replaced; an edited native JSON file
 * keeps its envelope values with canonical whitespace. Never invents
 * losslessness: an edited scene always reports its diff.
 */
export function saveDrawingFile(
  scene: DrawingScene,
  original?: ParsedDrawing | string | null,
): SaveDrawingResult {
  assertSceneShape(scene);
  if (original === undefined || original === null) {
    return { text: serializeDrawing(scene), noop: false, diff: null };
  }
  const parsed: ParsedDrawing =
    typeof original === 'string' ? parseDrawingFile(original) : original;
  if (scenesEqual(parsed.scene, scene)) {
    return { text: parsed.originalSource, noop: true, diff: null };
  }
  const diff = diffDrawingScenes(parsed.scene, scene);
  if (parsed.sourceKind === 'excalidraw-json') {
    return { text: serializeDrawing(scene), noop: false, diff };
  }
  return {
    text: replaceDrawingFence(parsed.originalSource, serializeDrawing(scene), parsed.sourceKind),
    noop: false,
    diff,
  };
}
