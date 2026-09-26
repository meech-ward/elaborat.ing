import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitNativeScene } from '../emitter.ts';
import type { D2Diagram } from '../types.ts';

const TWO_BOXES: D2Diagram = {
  shapes: [
    { id: 'a', type: 'rectangle', pos: { x: 0, y: 0 }, width: 69, height: 66, label: 'API' },
    { id: 'b', type: 'cylinder', pos: { x: 2, y: 187 }, width: 65, height: 118, label: 'DB' },
  ],
  connections: [
    {
      id: '(a -> b)[0]',
      src: 'a',
      dst: 'b',
      dstArrow: 'arrow',
      label: 'query',
      labelPosition: 'INSIDE_MIDDLE_CENTER',
      route: [
        { x: 34.5, y: 65.5 },
        { x: 34.5, y: 114.3 },
        { x: 34.6, y: 138.6 },
        { x: 35, y: 187 },
      ],
    },
  ],
};

function byId(elements: { id: string }[], id: string) {
  const el = elements.find((e) => e.id === id) as Record<string, unknown> | undefined;
  if (!el) throw new Error(`missing element ${id}`);
  return el;
}

describe('emitNativeScene', () => {
  test('node boxes use D2 measured dimensions verbatim', () => {
    const { elements } = emitNativeScene(TWO_BOXES);
    const a = byId(elements, 'd2:a');
    expect(a.type).toBe('rectangle');
    expect([a.x, a.y, a.width, a.height]).toEqual([0, 0, 69, 66]);
    const b = byId(elements, 'd2:b');
    expect([b.x, b.y, b.width, b.height]).toEqual([2, 187, 65, 118]);
  });

  test('labels stay native text bound to their container', () => {
    const { elements } = emitNativeScene(TWO_BOXES);
    const label = byId(elements, 'd2:a:label');
    expect(label.type).toBe('text');
    expect(label.text).toBe('API');
    expect(label.originalText).toBe('API');
    expect(label.containerId).toBe('d2:a');
    // Horizontally centered on the node (D2 node center x = 34.5).
    const cx = (label.x as number) + (label.width as number) / 2;
    expect(Math.abs(cx - 34.5)).toBeLessThan(1);
    const node = byId(elements, 'd2:a');
    expect(node.boundElements).toContainEqual({ type: 'text', id: 'd2:a:label' });
  });

  test('arrows follow the D2 route with real bindings', () => {
    const { elements } = emitNativeScene(TWO_BOXES);
    const arrow = byId(elements, 'd2:(a -> b)[0]');
    expect(arrow.type).toBe('arrow');
    expect([arrow.x, arrow.y]).toEqual([34.5, 65.5]);
    expect(arrow.points).toEqual([
      [0, 0],
      [0, 48.8],
      [0.1, 73.1],
      [0.5, 121.5],
    ]);
    expect(arrow.startBinding).toEqual({ elementId: 'd2:a', focus: 0, gap: 10 });
    expect(arrow.endBinding).toEqual({ elementId: 'd2:b', focus: 0, gap: 10 });
    expect(arrow.endArrowhead).toBe('arrow');
    // Edge label is bound text at the route midpoint (route[1] of 4 points).
    const edgeLabel = byId(elements, 'd2:(a -> b)[0]:label');
    expect(edgeLabel.text).toBe('query');
    expect(edgeLabel.containerId).toBe('d2:(a -> b)[0]');
    const lcx = (edgeLabel.x as number) + (edgeLabel.width as number) / 2;
    expect(Math.abs(lcx - 34.5)).toBeLessThan(1);
  });

  test('cylinder falls back to rectangle with a diagnostic, never a drop', () => {
    const { elements, diagnostics } = emitNativeScene(TWO_BOXES);
    expect(byId(elements, 'd2:b').type).toBe('rectangle');
    const warn = diagnostics.find((d) => d.code === 'emit/shape-fallback' && d.elementId === 'd2:b');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('cylinder');
  });

  test('unknown endpoints emit an unbound arrow plus a warning', () => {
    const { elements, diagnostics } = emitNativeScene({
      shapes: [{ id: 'a', type: 'rectangle', pos: { x: 0, y: 0 }, width: 50, height: 50 }],
      connections: [{ id: 'x', src: 'a', dst: 'ghost', route: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }],
    });
    const arrow = byId(elements, 'd2:x');
    expect(arrow.endBinding).toBeNull();
    expect(arrow.startBinding).toEqual({ elementId: 'd2:a', focus: 0, gap: 10 });
    expect(diagnostics.some((d) => d.code === 'emit/unbound-connection')).toBe(true);
  });

  test('missing route becomes a straight line with a warning', () => {
    const { elements, diagnostics } = emitNativeScene({
      shapes: [
        { id: 'a', type: 'rectangle', pos: { x: 0, y: 0 }, width: 50, height: 50 },
        { id: 'b', type: 'rectangle', pos: { x: 200, y: 0 }, width: 50, height: 50 },
      ],
      connections: [{ id: 'x', src: 'a', dst: 'b' }],
    });
    const arrow = byId(elements, 'd2:x');
    expect(arrow.points).toEqual([
      [0, 0],
      [200, 0],
    ]);
    expect(diagnostics.some((d) => d.code === 'emit/connection-no-route')).toBe(true);
  });

  test('emission is deterministic across runs', () => {
    const first = emitNativeScene(TWO_BOXES);
    const second = emitNativeScene(TWO_BOXES);
    expect(JSON.stringify(second.elements)).toBe(JSON.stringify(first.elements));
  });

  test('empty diagram yields an info diagnostic, not an error', () => {
    const { elements, diagnostics } = emitNativeScene({});
    expect(elements).toEqual([]);
    expect(diagnostics[0]?.code).toBe('emit/empty-diagram');
  });

  test('element indices are valid ordered fractional keys (never a10-style)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const diagram = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'd2-flow.json'), 'utf8'));
    const { elements } = emitNativeScene(diagram);
    // The real flow emits 16 elements: past the a9 boundary the old a${n} scheme broke.
    expect(elements.length).toBeGreaterThan(11);
    const indices = elements.map((el) => el.index as string);
    for (const index of indices) {
      expect(index).toMatch(/^[a-z][0-9a-z]+$/);
    }
    expect(new Set(indices).size).toBe(indices.length);
    expect([...indices].sort()).toEqual(indices);
    expect(indices.slice(0, 11)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'aa']);
  });

  test('edge labels sit at the arc-length midpoint of the D2 route', () => {
    const { elements } = emitNativeScene(TWO_BOXES);
    const label = byId(elements, 'd2:(a -> b)[0]:label');
    const route = TWO_BOXES.connections?.[0]?.route ?? [];
    let total = 0;
    const seg: number[] = [0];
    for (let i = 1; i < route.length; i++) {
      total += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
      seg.push(total);
    }
    let mx = route[0]!.x;
    let my = route[0]!.y;
    for (let i = 1; i < route.length; i++) {
      if (seg[i]! >= total / 2) {
        const t = (total / 2 - seg[i - 1]!) / (seg[i]! - seg[i - 1]!);
        mx = route[i - 1]!.x + (route[i]!.x - route[i - 1]!.x) * t;
        my = route[i - 1]!.y + (route[i]!.y - route[i - 1]!.y) * t;
        break;
      }
    }
    const lcx = (label.x as number) + (label.width as number) / 2;
    const lcy = (label.y as number) + (label.height as number) / 2;
    expect(Math.abs(lcx - mx)).toBeLessThan(2);
    expect(Math.abs(lcy - my)).toBeLessThan(2);
  });

  test('container labels are native editable text', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const diagram = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'd2-cloud.json'), 'utf8'));
    const { elements } = emitNativeScene(diagram);
    const frameLabel = byId(elements, 'd2:infra:label');
    expect(frameLabel.type).toBe('text');
    expect(frameLabel.text).toBe('VPC');
    expect(frameLabel.originalText).toBe('VPC');
  });
});
