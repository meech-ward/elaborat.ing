/**
 * Geometry tests against REAL measured D2 output.
 *
 * Fixtures are verbatim `result.diagram` JSON captured from
 * `@terrastruct/d2@0.1.33`. If the D2 version changes, recapture them
 * from the new compiler; these tests pin node boxes, edge routes and
 * labels, so a layout regression fails loudly instead of drifting.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitNativeScene } from '../emitter.ts';
import type { D2Diagram, ExcalidrawElementSkeleton } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): D2Diagram =>
  JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8')) as D2Diagram;

function need(elements: ExcalidrawElementSkeleton[], id: string): ExcalidrawElementSkeleton {
  const el = elements.find((e) => e.id === id);
  if (!el) throw new Error(`missing element ${id}`);
  return el;
}

function centerX(el: ExcalidrawElementSkeleton): number {
  return (el.x as number) + (el.width as number) / 2;
}

describe('flow fixture (decision + branch)', () => {
  const diagram = load('d2-flow.json');
  const { elements, diagnostics } = emitNativeScene(diagram);

  test('node boxes match D2 measured dimensions exactly', () => {
    expect([need(elements, 'd2:start').x, need(elements, 'd2:start').y]).toEqual([0, 88]);
    expect([need(elements, 'd2:start').width, need(elements, 'd2:start').height]).toEqual([106, 68]);
    expect(need(elements, 'd2:start').type).toBe('ellipse');
    expect(need(elements, 'd2:check').type).toBe('diamond');
    expect([need(elements, 'd2:check').width, need(elements, 'd2:check').height]).toEqual([184, 92]);
    expect(need(elements, 'd2:ship').type).toBe('rectangle');
  });

  test('every connection is a routed arrow with real bindings and a label', () => {
    for (const conn of diagram.connections ?? []) {
      const arrow = need(elements, `d2:${conn.id}`);
      expect(arrow.type).toBe('arrow');
      expect(conn.route?.length).toBeGreaterThan(1);
      expect((arrow.points as unknown[]).length).toBe(conn.route?.length ?? 0);
      expect(arrow.startBinding).toEqual({ elementId: `d2:${conn.src}`, focus: 0, gap: 10 });
      expect(arrow.endBinding).toEqual({ elementId: `d2:${conn.dst}`, focus: 0, gap: 10 });
      expect(arrow.startArrowhead).toBeNull();
      expect(arrow.endArrowhead).toBe('arrow');
      if (conn.label) {
        const label = need(elements, `d2:${conn.id}:label`);
        expect(label.type).toBe('text');
        expect(label.text).toBe(conn.label);
      }
    }
  });

  test('no fallback or error diagnostics on the flow', () => {
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(diagnostics.filter((d) => d.code === 'emit/shape-fallback')).toEqual([]);
  });
});

describe('erd fixture (tables with fields)', () => {
  const diagram = load('d2-erd.json');
  const { elements, diagnostics } = emitNativeScene(diagram);

  test('table boxes match D2 measured dimensions', () => {
    const users = need(elements, 'd2:users');
    expect([users.x, users.y, users.width, users.height]).toEqual([1, 0, 219, 144]);
  });

  test('every column is a native text row with constraint marks', () => {
    const texts = elements.filter((el) => el.type === 'text').map((el) => el.text as string);
    expect(texts).toContain('users');
    expect(texts).toContain('id: int [PK]');
    expect(texts).toContain('name: varchar');
    expect(texts).toContain('email: varchar [U]');
    expect(texts).toContain('user_id: int [FK]');
    // Rows sit inside the measured table box.
    const users = need(elements, 'd2:users');
    for (const id of ['d2:users:label', 'd2:users:col:id', 'd2:users:col:email']) {
      const row = need(elements, id);
      expect(row.x as number).toBeGreaterThanOrEqual(users.x as number);
      expect((row.x as number) + (row.width as number)).toBeLessThanOrEqual((users.x as number) + (users.width as number));
    }
  });

  test('bidirectional relationship gets both arrowheads', () => {
    const rel = need(elements, 'd2:(users <-> orders)[0]');
    expect(rel.startArrowhead).toBe('arrow');
    expect(rel.endArrowhead).toBe('arrow');
    expect(need(elements, 'd2:(users <-> orders)[0]:label').text).toBe('places');
  });

  test('no error diagnostics on the ERD', () => {
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('cloud fixture (grouped services)', () => {
  const diagram = load('d2-cloud.json');
  const { elements, diagnostics } = emitNativeScene(diagram);

  test('the VPC group is a frame containing its services', () => {
    const infra = need(elements, 'd2:infra');
    expect(infra.type).toBe('frame');
    expect([infra.x, infra.y, infra.width, infra.height]).toEqual([10, 20, 158, 313]);
    expect(need(elements, 'd2:infra.web').frameId).toBe('d2:infra');
    expect(need(elements, 'd2:infra.worker').frameId).toBe('d2:infra');
    expect([need(elements, 'd2:infra.web').x, need(elements, 'd2:infra.web').y]).toEqual([51, 50]);
  });

  test('database and cache fall back with diagnostics, never drops', () => {
    expect(need(elements, 'd2:db').type).toBe('rectangle');
    expect(need(elements, 'd2:cache').type).toBe('rectangle');
    const fallbacks = diagnostics.filter((d) => d.code === 'emit/shape-fallback').map((d) => d.elementId);
    expect(fallbacks).toContain('d2:db');
    expect(fallbacks).toContain('d2:cache');
  });

  test('all four connections are bound routed arrows', () => {
    expect(diagram.connections?.length).toBe(4);
    for (const conn of diagram.connections ?? []) {
      const arrow = need(elements, `d2:${conn.id}`);
      expect((arrow.points as unknown[]).length).toBeGreaterThan(1);
      expect(arrow.endArrowhead).toBe('arrow');
    }
    // Nested connection ids resolve to the dotted shape ids.
    expect(need(elements, 'd2:infra.(web -> worker)[0]').endBinding).toEqual({
      elementId: 'd2:infra.worker',
      focus: 0,
      gap: 10,
    });
  });
});

describe('legibility across fixtures', () => {
  for (const name of ['d2-flow.json', 'd2-erd.json', 'd2-cloud.json']) {
    test(`${name}: every text element is non-empty and every node label is centered`, () => {
      const { elements } = emitNativeScene(load(name));
      for (const el of elements) {
        if (el.type === 'text') {
          expect((el.text as string).length).toBeGreaterThan(0);
          expect(el.width as number).toBeGreaterThan(0);
        }
      }
      for (const el of elements) {
        if (typeof el.containerId === 'string' && el.containerId.startsWith('d2:') && !el.containerId.includes('->')) {
          const owner = elements.find((o) => o.id === el.containerId);
          if (owner && (owner.type === 'rectangle' || owner.type === 'ellipse' || owner.type === 'diamond')) {
            expect(Math.abs(centerX(el) - centerX(owner))).toBeLessThan(2);
          }
        }
      }
    });
  }
});
