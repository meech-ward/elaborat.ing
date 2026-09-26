import { describe, expect, test } from 'bun:test';
import { instrumentMdxSource } from './instrumentation';
import { componentValuePatch } from './componentValueEdit';

describe('source-backed component value edits', () => {
  test('updates a literal ratio without rewriting children or quote style', async () => {
    const source = "Before\n\n<SideBySide ratio='1:1'><SideBySide.Block>Keep &amp; preserve.</SideBySide.Block></SideBySide>\n\nAfter";
    const { components } = await instrumentMdxSource(source);
    const patch = componentValuePatch(source, components, { slot: 0, prop: 'ratio', value: '37.5:62.5' })!;
    expect(source.slice(0, patch.from) + patch.insert + source.slice(patch.to)).toBe(source.replace("'1:1'", "'37.5:62.5'"));
  });
  test('an omitted ratio or title gains one escaped attribute at the parsed tag', async () => {
    for (const [source, prop, value] of [
      ['<Instruction>\n\nKeep.\n\n</Instruction>', 'ratio', '40:60'],
      ['<Note>\n\nKeep.\n\n</Note>', 'title', 'A "quoted" & <title>'],
    ] as const) {
      const { components } = await instrumentMdxSource(source);
      const patch = componentValuePatch(source, components, { slot: 0, prop, value })!;
      const next = source.slice(0, patch.from) + patch.insert + source.slice(patch.to);
      const result = await instrumentMdxSource(next);
      expect(result.components[0].supported).toBe(true);
      expect(next.slice(patch.from + patch.insert.length)).toBe(source.slice(patch.to));
      expect(result.components[0].props[0].name).toBe(prop);
    }
  });
  test('rejects computed/spread values, unknown slots, undeclared targets and invalid ratios', async () => {
    for (const source of ['<SideBySide ratio={layout} />', '<SideBySide {...props} />', '<Card />']) {
      const { components } = await instrumentMdxSource(source);
      expect(() => componentValuePatch(source, components, { slot: 0, prop: 'ratio', value: '40:60' })).toThrow();
    }
    const source = '<SideBySide ratio="1:1" />';
    const { components } = await instrumentMdxSource(source);
    for (const value of ['0:1', '-1:2', 'NaN:2', '1:Infinity', '1:2:3', '1:{evil()}'])
      expect(() => componentValuePatch(source, components, { slot: 0, prop: 'ratio', value })).toThrow();
    expect(() => componentValuePatch(source, components, { slot: 999, prop: 'ratio', value: '1:1' })).toThrow();
    expect(() => componentValuePatch(source, components, { slot: 0, prop: 'title', value: 'x' })).toThrow();
  });
});
