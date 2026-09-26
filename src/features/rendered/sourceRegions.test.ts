import { expect, test } from 'bun:test';
import { applySourcePatches } from '../document';
import { encodeTextLeaf, instrumentMdxSource } from './instrumentation';
import { checkProseEdit } from './protocol';

test('code editing preserves surrounding bytes and code syntax, widening colliding fences only', async () => {
  const original = 'export const untouched = "keep";\n\n<Instruction.Implementation>\n\n```tsx title="Demo"\nconst before = 1;\n```\n\n</Instruction.Implementation>\n\nAfter.';
  const map = await instrumentMdxSource(original);
  const leaf = map.leaves.find(entry => entry.code)!;
  expect(checkProseEdit(map.leaves, leaf)).toBe(true);
  expect(checkProseEdit(map.leaves, { ...leaf, from: leaf.from + 1 })).toBe(false);
  const value = 'const node = <div>{"a&b"}</div>;\n```\nconst path = "c:\\tmp";\n';
  const insert = encodeTextLeaf(leaf, value, 'mdx');
  expect(insert).toBe('````tsx title="Demo"\n' + value + '\n````');
  const changed = applySourcePatches({ text: original, revision: 3, format: 'mdx' }, 3, [{ ...leaf, insert }]);
  expect(changed.text.slice(0, leaf.from)).toBe(original.slice(0, leaf.from));
  expect(changed.text.slice(leaf.from + insert.length)).toBe(original.slice(leaf.to));
  const updated = await instrumentMdxSource(changed.text);
  expect(updated.leaves.find(entry => entry.code)?.code?.value).toBe(value);
  const undo = applySourcePatches(changed, 4, [{ from: leaf.from, to: leaf.from + insert.length, expected: insert, insert: leaf.expected }]);
  expect(undo.text).toBe(original);
});

test('code no-op preserves CRLF and edits preserve indentation and longer closing fence', async () => {
  const source = '<Note>\r\n\r\n  ~~~js\r\n  const before = 1;\r\n  ~~~~\r\n\r\n</Note>';
  const map = await instrumentMdxSource(source);
  const leaf = map.leaves.find(entry => entry.code)!;
  expect(leaf).toBeDefined();
  expect(leaf.code!.value).toBe('const before = 1;');
  expect(encodeTextLeaf(leaf, leaf.code!.value, 'mdx')).toBe(leaf.expected);
  const insert = encodeTextLeaf(leaf, 'const after = 2;\nconst next = 3;', 'mdx');
  expect(insert).toBe('~~~js\r\n  const after = 2;\r\n  const next = 3;\r\n  ~~~~');
  const next = source.slice(0, leaf.from) + insert + source.slice(leaf.to);
  expect((await instrumentMdxSource(next)).leaves.find(entry => entry.code)?.code?.value).toBe('const after = 2;\nconst next = 3;');
});
