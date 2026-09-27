import { describe, expect, test } from 'bun:test';
import { emitNativeScene } from '../emitter.ts';
import { presentDiagramElements } from '../presentation.ts';

const colors = { stroke: '#111111', label: '#555555', fill: '#dddddd', fill2: '#eeeeee' };

describe('presentDiagramElements', () => {
  const { elements } = emitNativeScene({
    shapes: [
      { id: 'infra', type: 'rectangle', pos: { x: 0, y: 0 }, width: 300, height: 200, label: 'infra' },
      { id: 'infra.web', type: 'rectangle', pos: { x: 20, y: 40 }, width: 80, height: 50, label: 'web' },
      { id: 'user', type: 'oval', pos: { x: 400, y: 0 }, width: 80, height: 50, label: 'user' },
    ],
    connections: [
      { id: '(user -> infra.web)[0]', src: 'user', dst: 'infra.web', dstArrow: 'arrow', label: 'visits', route: [{ x: 400, y: 25 }, { x: 100, y: 65 }] },
    ],
  });
  const byId = (list: typeof elements, id: string) => list.find((element) => element.id === id) as Record<string, unknown>;

  test('generated shapes, arrows and labels take the diagram colours', () => {
    const shown = presentDiagramElements(elements, colors);
    expect(byId(shown, 'd2:user')).toMatchObject({ strokeColor: colors.stroke, backgroundColor: colors.fill });
    expect(byId(shown, 'd2:user:label')).toMatchObject({ strokeColor: colors.stroke });
    expect(byId(shown, 'd2:infra.web')).toMatchObject({ strokeColor: colors.stroke, backgroundColor: colors.fill2 });
    expect(byId(shown, 'd2:(user -> infra.web)[0]')).toMatchObject({ strokeColor: colors.stroke });
    expect(byId(shown, 'd2:(user -> infra.web)[0]:label')).toMatchObject({ strokeColor: colors.label });
  });

  test('colours set on the canvas and hand-drawn elements keep their own, and the scene is not changed', () => {
    const authored = elements.map((element) => (element.id === 'd2:user' ? { ...element, backgroundColor: '#ffc9c9', strokeColor: '#e03131' } : element));
    const drawn = { id: 'sketch', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#1e1e1e', backgroundColor: 'transparent' };
    const before = structuredClone([...authored, drawn]);
    const shown = presentDiagramElements([...authored, drawn], colors);
    expect(byId(shown, 'd2:user')).toMatchObject({ backgroundColor: '#ffc9c9', strokeColor: '#e03131' });
    expect(byId(shown, 'sketch')).toBe(drawn);
    expect([...authored, drawn]).toEqual(before);
    const plain = [drawn];
    expect(presentDiagramElements(plain, colors)).toBe(plain);
  });
});
