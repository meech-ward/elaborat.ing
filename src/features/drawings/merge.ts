// Library-restoration merge: the raw authored scene stays the authority,
// the native library model is a lossy view of it.
//
// On load the native canvas restores and normalizes: it drops legacy
// fields (rawText), fills defaults (link/boundElements), regenerates
// volatile metadata (updated/versionNonce) and churns ephemeral app state
// (scroll/zoom/selection). None of that is a user edit and none of it may
// leak into the saved file as if the user authored it.
//
// The canvas therefore keeps two pieces of state per loaded scene:
//   - raw: the verbatim authored DrawingScene (parse output or the last
//     merged authored result). Only real user deltas mutate it.
//   - baseline: a snapshot of what the library last reported. Library
//     events are diffed baseline -> current; only that delta is overlaid
//     onto raw, field-by-field and element-by-element. Unknown raw fields
//     the library drops (customData extras, plugin fields, rawText, loose
//     geometry) survive because the overlay starts from raw and only
//     touches fields the library actually changed.
//
// This module is pure (no React, no native package) so the merge contract
// is unit-testable. Snapshot inputs are untyped on purpose: they arrive
// from the vendor component at runtime, so shaping failures throw plain
// Errors instead of silently wiping the scene.

import { durableAppState, stableStringify } from './serialize.ts';
import type { BinaryFileData, DrawingElement, DrawingScene } from './types.ts';

/** What the native library last reported for one loaded scene. */
export interface LibrarySnapshot {
  elements: DrawingElement[];
  files: Record<string, BinaryFileData>;
  appState: Record<string, unknown>;
}

/** Result of reconciling one library event against the raw authority. */
export interface LibraryMergeResult {
  /** The raw scene when dirty, otherwise the identical raw input. */
  next: DrawingScene;
  /** True only when a real user delta was found. */
  dirty: boolean;
}

/** Native metadata regenerated on load; never an authored change. */
const VOLATILE_ELEMENT_KEYS = new Set(['updated', 'versionNonce']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneElement(element: DrawingElement): DrawingElement {
  return structuredClone(element) as DrawingElement;
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Freeze one library event into a snapshot. Elements must be an array
 * (anything else throws); null files/appState coerce to empty, matching
 * what the native component emits for scenes without images.
 */
export function snapshotLibraryState(
  elements: unknown,
  files: unknown,
  appState: unknown,
): LibrarySnapshot {
  if (!Array.isArray(elements)) {
    throw new Error('invalid library snapshot: expected elements to be an array');
  }
  const frozen = elements.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('invalid library snapshot: expected elements to be objects');
    }
    return structuredClone(entry) as DrawingElement;
  });
  return {
    elements: frozen,
    files: isRecord(files) ? (structuredClone(files) as Record<string, BinaryFileData>) : {},
    appState: isRecord(appState) ? { ...appState } : {},
  };
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
 * Overlay one library event onto the raw authority. A null baseline is the
 * first event after a load (or an external scene push): it carries only
 * restoration, so it is captured, never forwarded. Otherwise only the
 * baseline -> current delta mutates raw:
 * added elements are appended, removed ones drop, changed ones get exactly
 * the fields the library changed (volatile keys excluded), files merge
 * per id, and only durable app-state prefs (theme, viewBackgroundColor)
 * sync back. Scroll, selection, collaborators and hover never dirty raw.
 */
export function mergeLibraryUpdate(
  raw: DrawingScene,
  baseline: LibrarySnapshot | null,
  current: LibrarySnapshot,
): LibraryMergeResult {
  if (baseline === null) {
    return { next: raw, dirty: false };
  }
  let dirty = false;
  const baselineById = indexById(baseline.elements);
  const currentById = indexById(current.elements);

  const nextElements: DrawingElement[] = [];
  for (const currentElement of current.elements) {
    const base = baselineById.get(currentElement.id);
    if (!base) {
      nextElements.push(cloneElement(currentElement));
      dirty = true;
      continue;
    }
    const rawElement = raw.elements.find((element) => element.id === currentElement.id);
    if (!rawElement) {
      nextElements.push(cloneElement(currentElement));
      dirty = true;
      continue;
    }
    let merged = rawElement;
    let touched = false;
    const keys = new Set([...Object.keys(base), ...Object.keys(currentElement)]);
    for (const key of keys) {
      if (VOLATILE_ELEMENT_KEYS.has(key)) {
        continue;
      }
      const before = (base as Record<string, unknown>)[key];
      const after = (currentElement as Record<string, unknown>)[key];
      if (!sameValue(before, after)) {
        if (merged === rawElement) {
          merged = { ...rawElement };
        }
        if (key in currentElement) {
          (merged as Record<string, unknown>)[key] = structuredClone(after);
        } else {
          delete (merged as Record<string, unknown>)[key];
        }
        touched = true;
      }
    }
    if (touched) {
      dirty = true;
    }
    nextElements.push(merged);
  }

  // Raw elements the library no longer reports: a real removal drops them.
  // (Ids the library never knew are kept defensively; that path only
  // arises if a future library version skips an element type.)
  for (const rawElement of raw.elements) {
    if (!currentById.has(rawElement.id)) {
      if (baselineById.has(rawElement.id)) {
        dirty = true;
        continue;
      }
      nextElements.push(rawElement);
    }
  }

  const rawFiles = raw.files ?? {};
  const baselineFiles = baseline.files;
  const currentFiles = current.files;
  let nextFiles: Record<string, BinaryFileData> | undefined = raw.files;
  const fileIds = new Set([
    ...Object.keys(baselineFiles),
    ...Object.keys(currentFiles),
    ...Object.keys(rawFiles),
  ]);
  for (const id of fileIds) {
    const inBaseline = id in baselineFiles;
    const inCurrent = id in currentFiles;
    if (inBaseline && inCurrent) {
      if (!sameValue(baselineFiles[id], currentFiles[id])) {
        nextFiles = { ...(nextFiles ?? {}), [id]: structuredClone(currentFiles[id]) as BinaryFileData };
        dirty = true;
      }
      continue;
    }
    if (!inBaseline && inCurrent) {
      nextFiles = { ...(nextFiles ?? {}), [id]: structuredClone(currentFiles[id]) as BinaryFileData };
      dirty = true;
      continue;
    }
    if (inBaseline && !inCurrent) {
      // A library-side removal drops the file from raw only when raw
      // actually holds it; otherwise it is a no-op for the authority.
      if (nextFiles !== undefined && id in nextFiles) {
        const rest = { ...nextFiles };
        delete rest[id];
        nextFiles = rest;
        dirty = true;
      }
    }
  }

  let nextAppState = raw.appState;
  const beforeDurable = durableAppState(baseline.appState);
  const afterDurable = durableAppState(current.appState);
  // Only keys the library actually reports drive changes; an omitted
  // durable key means "unchanged", never "deleted".
  for (const key of Object.keys(afterDurable)) {
    if (!sameValue(beforeDurable[key], afterDurable[key])) {
      nextAppState = { ...(nextAppState ?? {}), [key]: structuredClone(afterDurable[key]) };
      dirty = true;
    }
  }

  if (!dirty) {
    return { next: raw, dirty: false };
  }
  const next: DrawingScene = { ...raw, elements: nextElements };
  if (nextAppState !== raw.appState) {
    next.appState = nextAppState;
  }
  if (nextFiles !== raw.files) {
    if (nextFiles !== undefined && Object.keys(nextFiles).length === 0 && raw.files === undefined) {
      // Keep absent files absent; do not invent an empty map.
    } else {
      next.files = nextFiles;
    }
  }
  return { next, dirty: true };
}
