import { describe, expect, test } from 'bun:test';
import {
  mergeLibraryUpdate,
  snapshotLibraryState,
  type LibrarySnapshot,
} from './merge.ts';
import type { BinaryFileData, DrawingElement, DrawingScene } from './types.ts';

/** Raw authored scene carrying legacy/unknown fields the library drops. */
function rawScene(): DrawingScene {
  const elements: DrawingElement[] = [
    {
      id: 'rect-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      seed: 42,
      version: 3,
      versionNonce: 111,
      updated: 1,
      isDeleted: false,
    },
    {
      id: 'text-1',
      type: 'text',
      x: 30,
      y: 40,
      width: 80,
      height: 25,
      text: 'hello',
      rawText: 'hello',
      originalText: 'hello',
      fontSize: 20,
      fontFamily: 1,
      seed: 43,
      version: 5,
      versionNonce: 222,
      updated: 1,
      isDeleted: false,
    },
    {
      id: 'plugin-rect',
      type: 'rectangle',
      x: 200,
      y: 200,
      width: 60,
      height: 60,
      myPlugin: { tag: 'keep-me', v: 3 },
      seed: 44,
      version: 1,
      versionNonce: 333,
      updated: 1,
      isDeleted: false,
    },
  ];
  return {
    type: 'excalidraw',
    version: 2,
    elements,
    appState: { theme: 'light', viewBackgroundColor: '#ffffff', scrollX: 10, scrollY: 20 },
    files: {},
  };
}

/**
 * What the native library reports after restoring the raw scene above:
 * legacy rawText dropped, unknown plugin field dropped, link/boundElements
 * defaults filled in, volatile metadata regenerated, scroll churned.
 */
function restoredLibraryState(raw: DrawingScene): LibrarySnapshot {
  const elements = raw.elements.map((element) => {
    const next: DrawingElement = { ...element };
    delete next['rawText'];
    delete next['myPlugin'];
    if (!('link' in next)) {
      next['link'] = null;
    }
    if (!('boundElements' in next)) {
      next['boundElements'] = [];
    }
    next['updated'] = 999999;
    next['versionNonce'] = 987654321;
    return next;
  });
  return snapshotLibraryState(elements, {}, { ...raw.appState, scrollX: 5000, scrollY: -300 });
}

describe('mergeLibraryUpdate', () => {
  test('library restoration noise is not an authored change', () => {
    const raw = rawScene();
    const current = restoredLibraryState(raw);
    const { next, dirty } = mergeLibraryUpdate(raw, null, current);
    expect(dirty).toBe(false);
    expect(next).toBe(raw);
    // A second restoration-shaped event against the captured baseline is
    // still quiet: the raw scene (with rawText/unknowns) is untouched.
    const again = mergeLibraryUpdate(raw, current, snapshotLibraryState(
      current.elements,
      current.files,
      { theme: 'light', viewBackgroundColor: '#ffffff', scrollX: 1, scrollY: 2 },
    ));
    expect(again.dirty).toBe(false);
    expect(again.next).toBe(raw);
  });

  test('an added library rectangle lands once; raw elements stay identical', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const added: DrawingElement = {
      id: 'rect-new',
      type: 'rectangle',
      x: 1,
      y: 2,
      width: 30,
      height: 30,
      seed: 99,
      version: 1,
      versionNonce: 555,
      updated: 7,
      isDeleted: false,
    };
    const current = snapshotLibraryState([...baseline.elements, added], {}, { theme: 'light' });
    const { next, dirty } = mergeLibraryUpdate(raw, baseline, current);
    expect(dirty).toBe(true);
    expect(next.elements.map((element) => element.id)).toEqual([
      'rect-1',
      'text-1',
      'plugin-rect',
      'rect-new',
    ]);
    // Original elements are byte-for-byte the raw ones (unknowns kept).
    expect(next.elements.slice(0, 3)).toEqual(raw.elements);
    expect(next.elements[2]?.['myPlugin']).toEqual({ tag: 'keep-me', v: 3 });
    expect(next.elements[1]?.['rawText']).toBe('hello');
  });

  test('a real text edit overlays only changed fields and keeps rawText', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const edited = baseline.elements.map((element) =>
      element.id === 'text-1'
        ? { ...element, text: 'hello there', version: 6, updated: 12345 }
        : element,
    );
    const current = snapshotLibraryState(edited, {}, { theme: 'light' });
    const { next, dirty } = mergeLibraryUpdate(raw, baseline, current);
    expect(dirty).toBe(true);
    const text = next.elements.find((element) => element.id === 'text-1');
    expect(text?.['text']).toBe('hello there');
    expect(text?.['version']).toBe(6);
    // Untouched raw fields on the edited element survive.
    expect(text?.['rawText']).toBe('hello');
    expect(text?.['originalText']).toBe('hello');
    // Unrelated elements are the identical raw objects.
    expect(next.elements.find((element) => element.id === 'rect-1')).toBe(raw.elements[0]);
    expect(next.elements.find((element) => element.id === 'plugin-rect')).toBe(raw.elements[2]);
  });

  test('volatile-only churn and scroll moves are never dirty', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const churned = baseline.elements.map((element) => ({
      ...element,
      updated: 424242,
      versionNonce: 777,
    }));
    const current = snapshotLibraryState(churned, {}, {
      theme: 'light',
      viewBackgroundColor: '#ffffff',
      scrollX: -999,
      scrollY: 888,
    });
    const { next, dirty } = mergeLibraryUpdate(raw, baseline, current);
    expect(dirty).toBe(false);
    expect(next).toBe(raw);
  });

  test('a durable background change is dirty; scroll is preserved verbatim', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const current = snapshotLibraryState(baseline.elements, baseline.files, {
      theme: 'light',
      viewBackgroundColor: '#000000',
      scrollX: 12345,
    });
    const { next, dirty } = mergeLibraryUpdate(raw, baseline, current);
    expect(dirty).toBe(true);
    expect(next.appState?.['viewBackgroundColor']).toBe('#000000');
    expect(next.appState?.['scrollX']).toBe(10);
  });

  test('removed elements drop; soft delete overlays isDeleted only', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const withoutRect = baseline.elements.filter((element) => element.id !== 'rect-1');
    const removed = mergeLibraryUpdate(
      raw,
      baseline,
      snapshotLibraryState(withoutRect, {}, {}),
    );
    expect(removed.dirty).toBe(true);
    expect(removed.next.elements.map((element) => element.id)).toEqual(['text-1', 'plugin-rect']);

    const softDeleted = baseline.elements.map((element) =>
      element.id === 'text-1' ? { ...element, isDeleted: true } : element,
    );
    const soft = mergeLibraryUpdate(
      raw,
      baseline,
      snapshotLibraryState(softDeleted, {}, {}),
    );
    expect(soft.dirty).toBe(true);
    const text = soft.next.elements.find((element) => element.id === 'text-1');
    expect(text?.['isDeleted']).toBe(true);
    expect(text?.['rawText']).toBe('hello');
  });

  test('added and updated files merge; library file churn stays out of raw', () => {
    const raw = rawScene();
    const baseline = restoredLibraryState(raw);
    const file: BinaryFileData = {
      mimeType: 'image/png',
      id: 'file-1',
      dataURL: 'data:image/png;base64,AAA',
      created: 123,
    };
    const current = snapshotLibraryState(
      [...baseline.elements, { ...baseline.elements[0]!, id: 'img-1', type: 'image' }],
      { 'file-1': file },
      {},
    );
    const { next, dirty } = mergeLibraryUpdate(raw, baseline, current);
    expect(dirty).toBe(true);
    expect(next.files?.['file-1']).toEqual(file);
  });

  test('malformed library snapshots fail loudly instead of wiping the scene', () => {
    expect(() => snapshotLibraryState(42, {}, {})).toThrow(/elements.*array/);
    expect(() => snapshotLibraryState('nope', {}, {})).toThrow(/elements.*array/);
    // Null files/appState are legitimate library output and coerce to empty.
    const coerced = snapshotLibraryState([], null, undefined);
    expect(coerced.elements).toEqual([]);
    expect(coerced.files).toEqual({});
  });
});
