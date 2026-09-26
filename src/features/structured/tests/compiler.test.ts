import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildCompileRequest,
  compileStructured,
  createD2CompilePort,
  hashSource,
  setSharedD2ForTest,
} from '../compiler.ts';
import { recordForElement } from '../merge.ts';
import type { D2Diagram } from '../types.ts';

afterEach(() => {
  setSharedD2ForTest(null);
});

const DIAGRAM: D2Diagram = {
  shapes: [{ id: 'a', type: 'rectangle', pos: { x: 0, y: 0 }, width: 80, height: 60, label: 'A' }],
  connections: [],
};

const portOk = () => async () => DIAGRAM;
const portThrow = (message: string) => async () => {
  throw new Error(message);
};

describe('compileStructured', () => {
  test('successful compile emits native elements plus a baseline', async () => {
    const out = await compileStructured('a: A', {}, { d2: portOk() });
    expect(out.ok).toBe(true);
    expect(out.scene.elements.map((el) => el.id)).toContain('d2:a');
    expect(out.scene.elements.map((el) => el.type)).toContain('text');
    expect(out.baseline?.elements['d2:a']).toMatchObject({ x: 0, y: 0, width: 80, height: 60 });
    expect(out.baseline?.sourceHash).toBe(hashSource('a: A'));
    expect(out.conflicts).toEqual([]);
  });

  test('syntax error preserves the prior scene and baseline', async () => {
    const priorScene = {
      elements: [{ id: 'd2:a', type: 'rectangle', x: 7, y: 7, width: 80, height: 60 }],
    };
    const priorBaseline = {
      language: 'd2' as const,
      sourceHash: 'old',
      elements: { 'd2:a': recordForElement(priorScene.elements[0]) },
    };
    const out = await compileStructured(
      'a -> : broken {{',
      { prior: { baseline: priorBaseline, scene: priorScene } },
      { d2: portThrow('syntax error near line 1') },
    );
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]?.code).toBe('d2/syntax');
    expect(out.scene).toEqual(priorScene);
    expect(out.baseline).toEqual(priorBaseline);
  });

  test('syntax error without a prior yields an empty scene, not a crash', async () => {
    const out = await compileStructured('oops {{', {}, { d2: portThrow('boom') });
    expect(out.ok).toBe(false);
    expect(out.scene.elements).toEqual([]);
    expect(out.baseline).toBeNull();
  });

  test('non-D2 languages are refused explicitly (no Mermaid path)', async () => {
    const out = await compileStructured('graph TD', { language: 'mermaid' as never }, { d2: portOk() });
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]?.code).toBe('structured/unsupported-language');
  });

  test('regeneration with a prior preserves a user move', async () => {
    const movedScene = {
      elements: [
        { id: 'd2:a', type: 'rectangle', x: 300, y: 0, width: 80, height: 60 },
        { id: 'd2:a:label', type: 'text', x: 0, y: 0, width: 10, height: 10 },
      ],
    };
    const fresh = await compileStructured('a: A', {}, { d2: portOk() });
    const out = await compileStructured(
      'a: A',
      { prior: { baseline: fresh.baseline, scene: movedScene } },
      { d2: portOk() },
    );
    expect(out.ok).toBe(true);
    expect(out.conflicts).toEqual([]);
    expect(out.scene.elements.find((el) => el.id === 'd2:a')?.x).toBe(300);
  });
});

describe('buildCompileRequest', () => {
  test('entry source lives at index.d2 alongside the virtual files', () => {
    const out = buildCompileRequest('a: A', { 'lib.d2': 'b: B' });
    expect(out.inputPath).toBe('index.d2');
    expect(out.fs['index.d2']).toBe('a: A');
    expect(out.fs['lib.d2']).toBe('b: B');
  });

  test('an index.d2 virtual file collides loudly instead of shadowing the entry', () => {
    expect(() => buildCompileRequest('a: A', { 'index.d2': 'b: B' })).toThrow('Conflicting virtual file');
  });
});

describe('hashSource', () => {
  test('deterministic and source-sensitive', () => {
    expect(hashSource('a: A')).toBe(hashSource('a: A'));
    expect(hashSource('a: A')).not.toBe(hashSource('a: B'));
  });
});

function diagramWithLabel(id: string, label: string): D2Diagram {
  return {
    shapes: [{ id, type: 'rectangle', pos: { x: 0, y: 0 }, width: 80, height: 60, label }],
    connections: [],
  };
}

describe('shared D2 serialization', () => {
  test('concurrent compiles through the shared instance each resolve their own geometry', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    setSharedD2ForTest({
      compile: async (input: string | { fs: Record<string, string> }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const source =
            typeof input === 'string' ? input : (input.fs['index.d2'] ?? 'unknown');
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { diagram: diagramWithLabel(source, `label:${source}`) };
        } finally {
          inFlight -= 1;
        }
      },
    });
    const port = createD2CompilePort();
    const [first, second, third] = await Promise.all([
      port({ source: 'aaa' }),
      port({ source: 'bbb' }),
      port({ source: 'ccc' }),
    ]);
    expect(first.shapes?.[0]?.label).toBe('label:aaa');
    expect(second.shapes?.[0]?.label).toBe('label:bbb');
    expect(third.shapes?.[0]?.label).toBe('label:ccc');
    // Serialized: the stub never observes overlapping compiles.
    expect(maxInFlight).toBe(1);
  });

  test('a rejected compile releases the queue and a later compile succeeds', async () => {
    let calls = 0;
    setSharedD2ForTest({
      compile: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (calls === 1) throw new Error('D2 syntax error: boom');
        return { diagram: diagramWithLabel('ok', 'recovered') };
      },
    });
    const port = createD2CompilePort();
    await expect(port({ source: 'broken :::' })).rejects.toThrow('boom');
    const recovered = await port({ source: 'a: A' });
    expect(recovered.shapes?.[0]?.label).toBe('recovered');
    expect(calls).toBe(2);
  });
});
