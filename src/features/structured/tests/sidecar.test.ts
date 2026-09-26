import { describe, expect, test } from 'bun:test';
import { parseOverrideSidecar, serializeOverrideSidecar } from '../sidecar.ts';

describe('override sidecar', () => {
  test('round trip preserves overrides and the generation baseline', () => {
    const baseline = {
      language: 'd2' as const,
      sourceHash: 'abc123',
      elements: {
        'd2:a': {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          style: {},
          snapshot: { id: 'd2:a' },
        },
      },
    };
    const text = serializeOverrideSidecar({
      version: 1,
      language: 'd2',
      sourceHash: 'abc123',
      overrides: { 'd2:a': { x: 50, strokeColor: '#e03131' } },
      baseline,
    });
    const parsed = parseOverrideSidecar(text);
    expect(parsed.sourceHash).toBe('abc123');
    expect(parsed.overrides['d2:a']).toEqual({ x: 50, strokeColor: '#e03131' });
    expect(parsed.baseline).toEqual(baseline);
  });

  test('sidecars written before baseline persistence recover as null baseline', () => {
    const parsed = parseOverrideSidecar(
      JSON.stringify({ version: 1, language: 'd2', sourceHash: 'abc123', overrides: {} }),
    );
    expect(parsed.baseline).toBeNull();
  });

  test('malformed sidecars throw descriptive errors', () => {
    expect(() => parseOverrideSidecar('not json')).toThrow('not JSON');
    expect(() => parseOverrideSidecar('{"version":2}')).toThrow('version 1');
    expect(() => parseOverrideSidecar('{"version":1,"language":"mermaid"}')).toThrow('"d2"');
    expect(() => parseOverrideSidecar('{"version":1,"language":"d2","sourceHash":"x","overrides":{},"baseline":42}')).toThrow(
      'baseline',
    );
    expect(() =>
      serializeOverrideSidecar({
        version: 1,
        language: 'd2',
        sourceHash: 'x',
        overrides: {},
      } as never),
    ).toThrow('baseline');
  });
});
