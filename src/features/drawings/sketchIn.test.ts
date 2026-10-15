import { describe, expect, test } from 'bun:test';
import { sketchMs } from '@/features/sketch/steps.ts';
import { SKETCH_BUDGET_MS, sketchSpeed } from './sketchIn.ts';

// How fast an agent's new elements are sketched in on the canvas: at the chat
// card's pace, unless that would take much longer than the budget in all.

describe('the pace of a sketch', () => {
  test('a few elements are sketched at the card\'s pace', () => {
    expect(sketchSpeed([600, 380, 600])).toBe(1);
    expect(sketchSpeed([])).toBe(1);
  });

  test('a big addition goes faster, so the whole sketch takes about the budget', () => {
    const durations = Array.from({ length: 40 }, (_, index) => 300 + (index % 4) * 150);
    const speed = sketchSpeed(durations);
    expect(speed).toBeGreaterThan(1);
    expect(sketchMs(durations.map((ms) => ({ ms: ms / speed })))).toBeCloseTo(SKETCH_BUDGET_MS, 6);
  });
});
