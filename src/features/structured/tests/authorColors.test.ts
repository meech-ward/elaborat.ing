import { describe, expect, test } from 'bun:test';
import { compileStructured } from '../compiler.ts';
import { emitNativeScene, GENERATED_FILL, GENERATED_STROKE } from '../emitter.ts';
import { presentDiagramElements } from '../presentation.ts';
import type { D2Diagram, NativeScene } from '../types.ts';

// Colours as the real compiler reports them (see d2-live.test.ts): theme
// codes for what the source leaves unstyled, the author's value otherwise.
const route = [{ x: 40, y: 60 }, { x: 40, y: 200 }];
function diagram(fill: string, stroke = 'red'): D2Diagram {
  return {
    shapes: [
      { id: 'a', type: 'rectangle', pos: { x: 0, y: 0 }, width: 80, height: 60, label: 'A', fill, stroke, color: '#123456' },
      { id: 'b', type: 'rectangle', pos: { x: 0, y: 200 }, width: 80, height: 60, label: 'B', fill: 'B6', stroke: 'B1', color: 'N1' },
    ],
    connections: [
      { id: '(a -> b)[0]', src: 'a', dst: 'b', dstArrow: 'triangle', label: 'hi', route, stroke: 'blue', color: 'green' },
      { id: '(b -> a)[0]', src: 'b', dst: 'a', dstArrow: 'triangle', route: [...route].reverse(), stroke: 'B1', color: 'N2' },
    ],
  };
}

const light = { stroke: '#111111', label: '#555555', fill: '#dddddd', fill2: '#eeeeee' };
const dark = { stroke: '#eeeeee', label: '#aaaaaa', fill: '#222222', fill2: '#333333' };
const field = (elements: NativeScene['elements'], id: string) => elements.find((el) => el.id === id) as Record<string, unknown>;

describe('colours written in D2', () => {
  test('an author fill and stroke on a shape show in every palette', () => {
    const { elements } = emitNativeScene(diagram('#ffd6d6'));
    expect(field(elements, 'd2:a')).toMatchObject({ backgroundColor: '#ffd6d6', strokeColor: 'red' });
    expect(field(elements, 'd2:a:label')).toMatchObject({ strokeColor: '#123456' });
    for (const colors of [light, dark]) {
      const shown = presentDiagramElements(elements, colors);
      expect(field(shown, 'd2:a')).toMatchObject({ backgroundColor: '#ffd6d6', strokeColor: 'red' });
      expect(field(shown, 'd2:a:label')).toMatchObject({ strokeColor: '#123456' });
    }
    // A transparent fill stays clear instead of taking the palette's fill.
    const clear = emitNativeScene(diagram('transparent')).elements;
    expect(field(presentDiagramElements(clear, light), 'd2:a').backgroundColor).toBe('#00000000');
  });

  test('an author stroke on a connection shows in every palette', () => {
    const { elements } = emitNativeScene(diagram('#ffd6d6'));
    expect(field(elements, 'd2:(a -> b)[0]')).toMatchObject({ strokeColor: 'blue' });
    expect(field(elements, 'd2:(a -> b)[0]:label')).toMatchObject({ strokeColor: 'green' });
    for (const colors of [light, dark]) {
      const shown = presentDiagramElements(elements, colors);
      expect(field(shown, 'd2:(a -> b)[0]')).toMatchObject({ strokeColor: 'blue' });
      expect(field(shown, 'd2:(a -> b)[0]:label')).toMatchObject({ strokeColor: 'green' });
      expect(field(shown, 'd2:(b -> a)[0]')).toMatchObject({ strokeColor: colors.stroke });
    }
  });

  test('a shape without style keeps the palette colours', () => {
    // A gradient has no native counterpart, so it counts as unstyled too.
    const { elements } = emitNativeScene(diagram('linear-gradient(red, blue)', 'B1'));
    for (const id of ['d2:a', 'd2:b']) {
      expect(field(elements, id)).toMatchObject({ backgroundColor: GENERATED_FILL, strokeColor: GENERATED_STROKE });
      expect(field(presentDiagramElements(elements, light), id)).toMatchObject({ backgroundColor: light.fill, strokeColor: light.stroke });
    }
    expect(field(presentDiagramElements(elements, light), 'd2:b:label')).toMatchObject({ strokeColor: light.stroke });
  });

  test('a regenerate brings a colour changed in the code, and keeps one changed on the canvas', async () => {
    const first = await compileStructured('v1', {}, { d2: async () => diagram('#ffd6d6') });
    const next = async () => diagram('#ff0000', 'purple');
    const regenerated = await compileStructured('v2', { prior: { baseline: first.baseline, scene: first.scene } }, { d2: next });
    expect(regenerated.conflicts).toEqual([]);
    expect(field(regenerated.scene.elements, 'd2:a')).toMatchObject({ backgroundColor: '#ff0000', strokeColor: 'purple' });

    const recoloured = first.scene.elements.map((el) => (el.id === 'd2:a' ? { ...el, backgroundColor: '#b2f2bb' } : el));
    const kept = await compileStructured('v2', { prior: { baseline: first.baseline, scene: { elements: recoloured } } }, { d2: next });
    expect(field(kept.scene.elements, 'd2:a')).toMatchObject({ backgroundColor: '#b2f2bb', strokeColor: 'purple' });
    expect(kept.conflicts.map((c) => c.kind)).toEqual(['styled']);
  });
});
