import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitNativeScene } from '../emitter.ts';
import {
  elementIdForConnection,
  elementIdForLabel,
  elementIdForShape,
  mergeRegeneration,
  recordForElement,
  resetOverrides,
} from '../merge.ts';
import type { ExcalidrawElementSkeleton, GeneratedBaseline, NativeScene } from '../types.ts';

function rect(id: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'rectangle',
    x,
    y: 10,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    ...extra,
  };
}

function baselineFor(elements: { id: string; x: number }[]): GeneratedBaseline {
  const elementsMap: GeneratedBaseline['elements'] = {};
  for (const el of elements) {
    elementsMap[el.id] = recordForElement(rect(el.id, el.x));
  }
  return { language: 'd2', sourceHash: 'base', elements: elementsMap };
}

describe('stable generated ids', () => {
  test('shape, connection and label ids derive from D2 source ids', () => {
    expect(elementIdForShape('api')).toBe('d2:api');
    expect(elementIdForConnection('(a -> b)[0]')).toBe('d2:(a -> b)[0]');
    expect(elementIdForLabel('d2:api')).toBe('d2:api:label');
  });
});

describe('mergeRegeneration', () => {
  test('an elbow-layout upgrade keeps a human-routed generated arrow coherent', () => {
    const old = rect('d2:edge', 0, { type: 'arrow', elbowed: false, points: [[0, 0], [100, 60]], startBinding: null, endBinding: null });
    const authored = { ...old, points: [[0, 0], [30, 80], [100, 60]], strokeColor: '#f00' };
    const fresh = { ...old, elbowed: true, points: [[0, 0], [100, 0], [100, 60]], fixedSegments: null, startIsSpecial: null, endIsSpecial: null };
    const baseline: GeneratedBaseline = { language: 'd2', sourceHash: 'old', elements: { [old.id]: recordForElement(old) } };
    const free = { ...authored, id: 'human-arrow' };
    const out = mergeRegeneration({ baseline, currentScene: { elements: [authored, free] }, freshScene: { elements: [fresh] }, freshBaseline: { ...baseline, elements: { [old.id]: recordForElement(fresh) } } });
    expect(out.scene.elements[0]).toEqual(authored);
    expect(out.scene.elements[1]).toEqual(free);
    const untouched = mergeRegeneration({ baseline, currentScene: { elements: [old] }, freshScene: { elements: [fresh] }, freshBaseline: baseline });
    expect(untouched.scene.elements[0].elbowed).toBe(true);
  });
  test('untouched regeneration returns the fresh scene with no conflicts', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const fresh: NativeScene = { elements: [rect('d2:a', 0)] };
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0)] },
      freshScene: fresh,
      freshBaseline: baselineFor([{ id: 'd2:a', x: 0 }]),
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements.map((el) => el.id)).toEqual(['d2:a']);
  });

  test('user move survives a regeneration that did not move the node', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 50)] },
      freshScene: { elements: [rect('d2:a', 0)] },
      freshBaseline: baselineFor([{ id: 'd2:a', x: 0 }]),
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements[0]?.x).toBe(50);
  });

  test('fresh move applies when the user never touched the node', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0)] },
      freshScene: { elements: [rect('d2:a', 200)] },
      freshBaseline: baselineFor([{ id: 'd2:a', x: 200 }]),
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements[0]?.x).toBe(200);
  });

  test('both sides moved the same node: user wins plus a conflict', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 50)] },
      freshScene: { elements: [rect('d2:a', 200)] },
      freshBaseline: baselineFor([{ id: 'd2:a', x: 200 }]),
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.kind).toBe('moved');
    expect(out.scene.elements[0]?.x).toBe(50);
  });

  test('user style override survives; conflicting style reports', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const current: NativeScene = { elements: [rect('d2:a', 0, { strokeColor: '#e03131' })] };
    const fresh: NativeScene = { elements: [rect('d2:a', 0, { strokeColor: '#1971c2' })] };
    const out = mergeRegeneration({
      baseline: { ...base, elements: { 'd2:a': recordForElement(rect('d2:a', 0)) } },
      currentScene: current,
      freshScene: fresh,
      freshBaseline: base,
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.kind).toBe('styled');
    expect(out.scene.elements[0]?.strokeColor).toBe('#e03131');
  });

  test('freehand additions and unbound arrows pass through untouched', () => {
    const base = baselineFor([{ id: 'd2:a', x: 0 }]);
    const free = { id: 'free-1', type: 'freedraw', x: 5, y: 5, width: 9, height: 9 };
    const loose = {
      id: 'loose-arrow',
      type: 'arrow',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      startBinding: null,
      endBinding: null,
    };
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0), free, loose] },
      freshScene: { elements: [rect('d2:a', 0), rect('d2:b', 300)] },
      freshBaseline: baselineFor([
        { id: 'd2:a', x: 0 },
        { id: 'd2:b', x: 300 },
      ]),
    });
    const ids = out.scene.elements.map((el) => el.id);
    expect(ids).toContain('free-1');
    expect(ids).toContain('loose-arrow');
    expect(ids).toContain('d2:b');
    expect(out.conflicts).toEqual([]);
  });

  test('user-deleted generated element stays deleted with a diagnostic', () => {
    const base = baselineFor([
      { id: 'd2:a', x: 0 },
      { id: 'd2:b', x: 300 },
    ]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0)] },
      freshScene: { elements: [rect('d2:a', 0), rect('d2:b', 300)] },
      freshBaseline: base,
    });
    expect(out.scene.elements.map((el) => el.id)).toEqual(['d2:a']);
    expect(out.diagnostics.some((d) => d.code === 'merge/kept-deletion')).toBe(true);
  });

  test('untouched element dropped by the source is removed; touched is kept with conflict', () => {
    const base = baselineFor([
      { id: 'd2:a', x: 0 },
      { id: 'd2:gone', x: 300 },
    ]);
    const droppedClean = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0), rect('d2:gone', 300)] },
      freshScene: { elements: [rect('d2:a', 0)] },
      freshBaseline: baselineFor([{ id: 'd2:a', x: 0 }]),
    });
    expect(droppedClean.scene.elements.map((el) => el.id)).toEqual(['d2:a']);

    const droppedTouched = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [rect('d2:a', 0), rect('d2:gone', 999)] },
      freshScene: { elements: [rect('d2:a', 0)] },
      freshBaseline: baselineFor([{ id: 'd2:a', x: 0 }]),
    });
    expect(droppedTouched.scene.elements.map((el) => el.id)).toContain('d2:gone');
    expect(droppedTouched.conflicts[0]?.kind).toBe('removed-by-source');
  });
});

describe('field-wise three-way merge', () => {
  function node(id: string, fields: Record<string, unknown> = {}) {
    return {
      id,
      type: 'rectangle',
      x: 0,
      y: 10,
      width: 100,
      height: 60,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      text: 'A',
      ...fields,
    };
  }

  function baseOf(elements: ExcalidrawElementSkeleton[]): GeneratedBaseline {
    const map: GeneratedBaseline['elements'] = {};
    for (const el of elements) map[el.id] = recordForElement(el);
    return { language: 'd2', sourceHash: 'base', elements: map };
  }

  test('user move plus fresh label change both survive with no conflict', () => {
    const base = baseOf([node('d2:a')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [node('d2:a', { x: 50 })] },
      freshScene: { elements: [node('d2:a', { text: 'B' })] },
      freshBaseline: baseOf([node('d2:a', { text: 'B' })]),
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements[0]?.x).toBe(50);
    expect(out.scene.elements[0]?.text).toBe('B');
  });

  test('canvas-edited native text survives an untouched regeneration', () => {
    const base = baseOf([node('d2:a')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [node('d2:a', { text: 'A-edited' })] },
      freshScene: { elements: [node('d2:a')] },
      freshBaseline: base,
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements[0]?.text).toBe('A-edited');
  });

  test('unknown native fields on generated elements survive regeneration', () => {
    const base = baseOf([node('d2:a')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [node('d2:a', { customData: { note: 'keep me' } })] },
      freshScene: { elements: [node('d2:a')] },
      freshBaseline: base,
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements[0]?.customData).toEqual({ note: 'keep me' });
  });

  test('user deletion stays a tombstone when the source still generates the element', () => {
    const base = baseOf([node('d2:a'), node('d2:b')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: {
        elements: [node('d2:a'), node('d2:b', { isDeleted: true })],
      },
      freshScene: { elements: [node('d2:a'), node('d2:b')] },
      freshBaseline: base,
    });
    const kept = out.scene.elements.find((el) => el.id === 'd2:b');
    expect(kept?.isDeleted).toBe(true);
    expect(out.diagnostics.some((d) => d.code === 'merge/kept-deletion')).toBe(true);
  });

  test('convergent edits to the same value report no conflict', () => {
    const base = baseOf([node('d2:a')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [node('d2:a', { text: 'same' })] },
      freshScene: { elements: [node('d2:a', { text: 'same' })] },
      freshBaseline: baseOf([node('d2:a', { text: 'same' })]),
    });
    expect(out.scene.elements[0]?.text).toBe('same');
    expect(out.conflicts).toEqual([]);
  });

  test('same-field text edits on both sides keep the user text and report a conflict', () => {
    const base = baseOf([node('d2:a')]);
    const out = mergeRegeneration({
      baseline: base,
      currentScene: { elements: [node('d2:a', { text: 'mine' })] },
      freshScene: { elements: [node('d2:a', { text: 'yours' })] },
      freshBaseline: baseOf([node('d2:a', { text: 'yours' })]),
    });
    expect(out.scene.elements[0]?.text).toBe('mine');
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.elementId).toBe('d2:a');
    expect(out.conflicts[0]?.message).toMatch(/text/);
  });

  test('scene root appState/files survive merge and reset', () => {
    const base = baseOf([node('d2:a')]);
    const currentScene = {
      elements: [node('d2:a', { x: 50 })],
      appState: { viewBackgroundColor: '#fafafa' },
      files: { 'img-1': { id: 'img-1' } },
    };
    const merged = mergeRegeneration({
      baseline: base,
      currentScene,
      freshScene: { elements: [node('d2:a')] },
      freshBaseline: base,
    });
    expect(merged.scene.appState).toEqual({ viewBackgroundColor: '#fafafa' });
    expect(merged.scene.files).toEqual({ 'img-1': { id: 'img-1' } });
    expect(merged.scene.elements[0]?.x).toBe(50);

    const reset = resetOverrides({
      currentScene,
      freshScene: { elements: [node('d2:a')] },
      freshBaseline: base,
    });
    expect(reset.scene.appState).toEqual({ viewBackgroundColor: '#fafafa' });
    expect(reset.scene.files).toEqual({ 'img-1': { id: 'img-1' } });
  });
});

describe('field-wise merge over the real flow emission', () => {
  test('moved node, fresh label edit and free annotation all survive', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const diagram = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'd2-flow.json'), 'utf8'));
    const first = emitNativeScene(diagram);
    const generated = first.elements.filter((el) => el.id.startsWith('d2:'));
    const baseline: GeneratedBaseline = {
      language: 'd2',
      sourceHash: 'flow-v1',
      elements: Object.fromEntries(generated.map((el) => [el.id, recordForElement(el)])),
    };
    // User drags the decision diamond and adds a freehand note.
    const current: NativeScene = {
      elements: [
        ...first.elements.map((el) =>
          el.id === 'd2:check' ? { ...el, x: (el.x as number) + 50 } : el,
        ),
        { id: 'note-1', type: 'text', x: 1, y: 1, width: 60, height: 20, text: 'review' },
      ],
    };
    // New source relabels the decision (label element changes, geometry does not).
    const fresh: NativeScene = {
      elements: first.elements.map((el) =>
        el.id === 'd2:check:label' ? { ...el, text: 'Approved!!', originalText: 'Approved!!' } : el,
      ),
    };
    const out = mergeRegeneration({
      baseline,
      currentScene: current,
      freshScene: fresh,
      freshBaseline: baseline,
    });
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements.find((el) => el.id === 'd2:check')?.x).toBe(
      (first.elements.find((el) => el.id === 'd2:check')?.x as number) + 50,
    );
    expect(out.scene.elements.find((el) => el.id === 'd2:check:label')?.text).toBe('Approved!!');
    expect(out.scene.elements.some((el) => el.id === 'note-1')).toBe(true);
  });
});

describe('resetOverrides', () => {
  test('explicit reset restores generated layout and keeps freehand work', () => {
    const current: NativeScene = {
      elements: [rect('d2:a', 50, { strokeColor: '#e03131' }), { id: 'note', type: 'text', x: 1, y: 1, width: 5, height: 5 }],
    };
    const out = resetOverrides({
      currentScene: current,
      freshScene: { elements: [rect('d2:a', 200), rect('d2:b', 300)] },
      freshBaseline: baselineFor([
        { id: 'd2:a', x: 200 },
        { id: 'd2:b', x: 300 },
      ]),
    });
    expect(out.conflicts).toEqual([]);
    const byId = new Map(out.scene.elements.map((el) => [el.id, el]));
    expect(byId.get('d2:a')?.x).toBe(200);
    expect(byId.get('d2:b')?.x).toBe(300);
    expect(byId.has('note')).toBe(true);
  });
});
