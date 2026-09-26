import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySourcePatches,
  encodeProseText,
  type DocumentSnapshot,
} from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = here;
const mixedSource = readFileSync(join(fixtureDir, 'mixed-prose.mdx'), 'utf8');

function doc(text: string, revision = 4, format: 'md' | 'mdx' = 'mdx'): DocumentSnapshot {
  return { text, revision, format };
}

describe('applySourcePatches', () => {
  test('empty patch list leaves text and revision untouched', () => {
    const d = doc('hello');
    const out = applySourcePatches(d, 4, []);
    expect(out.text).toBe('hello');
    expect(out.revision).toBe(4);
    expect(out.format).toBe('mdx');
  });

  test('no-op patch (insert equals covered text) does not bump revision', () => {
    const d = doc('hello world');
    const out = applySourcePatches(d, 4, [{ from: 0, to: 5, insert: 'hello', expected: 'hello' }]);
    expect(out.text).toBe('hello world');
    expect(out.revision).toBe(4);
  });

  test('a real edit bumps revision by exactly one', () => {
    const d = doc('hello world');
    const out = applySourcePatches(d, 4, [{ from: 6, to: 11, insert: 'there', expected: 'world' }]);
    expect(out.text).toBe('hello there');
    expect(out.revision).toBe(5);
    expect(out.format).toBe('mdx');
  });

  test('rendered prose edit preserves unrelated source byte-for-byte', () => {
    const d = doc(mixedSource, 9);
    const target = 'Second line with an emoji 🎉 inline.';
    const from = mixedSource.indexOf(target);
    expect(from).toBeGreaterThan(-1);
    const to = from + target.length;
    const insert = 'Second line with an emoji 🎉 revised.';
    const out = applySourcePatches(d, 9, [{ from, to, insert, expected: target }]);
    expect(out.revision).toBe(10);
    // Everything outside the patched range is identical.
    expect(out.text.slice(0, from)).toBe(mixedSource.slice(0, from));
    expect(out.text.slice(from + insert.length)).toBe(mixedSource.slice(to));
    // Spot-check adversarial survivors: imports, comment spacing, table, expression.
    expect(out.text).toContain("import { Counter } from './components/Counter';");
    expect(out.text).toContain('{/* Keep this comment exactly: spacing  matters   here */}');
    expect(out.text).toContain('| 1 | 2 |');
    expect(out.text).toContain('{helper(21)}');
    expect(out.text).toContain('<Counter initial={3} label="Clicks" />');
    expect(out.text).toContain('trailing spaces.   \n');
  });

  test('multiple disjoint patches apply atomically with one revision bump', () => {
    const d = doc('aaa bbb ccc', 1, 'md');
    const out = applySourcePatches(d, 1, [
      { from: 8, to: 11, insert: 'CCC', expected: 'ccc' },
      { from: 0, to: 3, insert: 'AAA', expected: 'aaa' },
    ]);
    expect(out.text).toBe('AAA bbb CCC');
    expect(out.revision).toBe(2);
  });

  test('adjacent patches (touching edges) are allowed', () => {
    const d = doc('abcdef', 0, 'md');
    const out = applySourcePatches(d, 0, [
      { from: 0, to: 3, insert: 'ABC', expected: 'abc' },
      { from: 3, to: 6, insert: 'DEF', expected: 'def' },
    ]);
    expect(out.text).toBe('ABCDEF');
    expect(out.revision).toBe(1);
  });

  test('UTF-16 offsets work around emoji (surrogate pairs)', () => {
    const text = '🎉 party 🎉 hats';
    const d = doc(text, 2, 'md');
    const target = 'hats';
    const from = text.indexOf(target); // code-unit index past two surrogate pairs
    const out = applySourcePatches(d, 2, [{ from, to: from + 4, insert: 'caps', expected: target }]);
    expect(out.text).toBe('🎉 party 🎉 caps');
    expect(out.revision).toBe(3);
  });

  test('CRLF documents patch with CRLF-aware offsets', () => {
    const text = 'line one\r\nline two\r\nline three';
    const d = doc(text, 7, 'md');
    const target = 'line two';
    const from = text.indexOf(target);
    const out = applySourcePatches(d, 7, [
      { from, to: from + target.length, insert: 'LINE TWO', expected: target },
    ]);
    expect(out.text).toBe('line one\r\nLINE TWO\r\nline three');
    expect(out.revision).toBe(8);
  });

  test('stale revision throws and leaves the document unchanged', () => {
    const d = doc('hello world', 5);
    expect(() =>
      applySourcePatches(d, 4, [{ from: 0, to: 5, insert: 'bye', expected: 'hello' }]),
    ).toThrow(/stale revision/i);
    expect(d.text).toBe('hello world');
    expect(d.revision).toBe(5);
  });

  test('overlapping patches throw', () => {
    const d = doc('abcdefgh', 0, 'md');
    expect(() =>
      applySourcePatches(d, 0, [
        { from: 0, to: 5, insert: 'x', expected: 'abcde' },
        { from: 3, to: 8, insert: 'y', expected: 'defgh' },
      ]),
    ).toThrow(/overlap/i);
  });

  test('nested patch inside another patch throws', () => {
    const d = doc('abcdefgh', 0, 'md');
    expect(() =>
      applySourcePatches(d, 0, [
        { from: 0, to: 8, insert: 'x', expected: 'abcdefgh' },
        { from: 2, to: 4, insert: 'y', expected: 'cd' },
      ]),
    ).toThrow(/overlap/i);
  });

  test('expected-text mismatch throws without mutating', () => {
    const d = doc('hello world', 3);
    expect(() =>
      applySourcePatches(d, 3, [{ from: 0, to: 5, insert: 'bye', expected: 'hello!' }]),
    ).toThrow(/mismatch|expected/i);
    expect(d.text).toBe('hello world');
    expect(d.revision).toBe(3);
  });

  test('invalid offsets throw: negative, reversed, out of bounds, non-integer', () => {
    const d = doc('hello', 0, 'md');
    const bad: Array<[number, number]> = [
      [-1, 2],
      [3, 2],
      [0, 99],
      [1.5, 3],
      [0, Number.NaN],
    ];
    for (const [from, to] of bad) {
      expect(() => applySourcePatches(d, 0, [{ from, to, insert: 'x', expected: '' }])).toThrow(
        /offset|range|invalid/i,
      );
    }
  });

  test('pure insertion (empty range) requires empty expected text', () => {
    const d = doc('ac', 0, 'md');
    const out = applySourcePatches(d, 0, [{ from: 1, to: 1, insert: 'b', expected: '' }]);
    expect(out.text).toBe('abc');
    expect(() =>
      applySourcePatches(d, 0, [{ from: 1, to: 1, insert: 'b', expected: 'z' }]),
    ).toThrow(/mismatch|expected/i);
  });
});

describe('encodeProseText', () => {
  test('escapes inline metacharacters without forming code or links', () => {
    const out = encodeProseText('*hi* `code` [link](http://x) a|b ~~s~~ \\ back', 'md');
    expect(out).toBe(
      '\\*hi\\* \\`code\\` \\[link\\](http://x) a\\|b \\~\\~s\\~\\~ \\\\ back',
    );
    // Every backtick is backslash-escaped, so no bare code span or fence can form.
    expect(/(^|[^\\])`/.test(out)).toBe(false);
  });

  test('mdx format additionally escapes braces and angle brackets', () => {
    const out = encodeProseText('set {helper(21)} and <Counter x={1} />', 'mdx');
    expect(out).toBe('set \\{helper(21)\\} and \\<Counter x=\\{1\\} />');
  });

  test('md format leaves braces alone but still escapes angle brackets', () => {
    const out = encodeProseText('set {x} and <b>hi</b>', 'md');
    expect(out).toBe('set {x} and \\<b>hi\\</b>');
  });

  test('neutralises line-leading block markers', () => {
    const out = encodeProseText('# Title\n> quote\n- item\n+ plus\n1. one\n2) two', 'md');
    expect(out).toBe('\\# Title\n\\> quote\n\\- item\n\\+ plus\n1\\. one\n2\\) two');
  });

  test('keeps literal entity-looking text and indentation from changing meaning', () => {
    expect(encodeProseText('&copy; &#123; & word', 'mdx')).toBe('&amp;copy; &amp;#123; &amp; word');
    expect(encodeProseText('    indented prose', 'md')).toBe('&#32;   indented prose');
    expect(encodeProseText('\tindented prose', 'mdx')).toBe('&#9;indented prose');
  });

  test('neutralises thematic-break and setext-like lines', () => {
    expect(encodeProseText('---', 'md')).toBe('\\---');
    expect(encodeProseText('===', 'md')).toBe('\\===');
  });

  test('plain prose passes through unchanged', () => {
    expect(encodeProseText('Just a calm sentence, 3.5 stars.', 'md')).toBe(
      'Just a calm sentence, 3.5 stars.',
    );
    expect(encodeProseText('', 'md')).toBe('');
  });

  test('normalises CRLF to LF', () => {
    expect(encodeProseText('a\r\nb\rc', 'md')).toBe('a\nb\nc');
  });

  test('encoded output spliced through applySourcePatches stays inert prose', () => {
    const before = '# Doc\n\n';
    const after = '\n\n> keep me';
    const d = doc(before + 'PLACEHOLDER' + after, 0, 'md');
    const encoded = encodeProseText('# Not a heading\n- not a list `x`', 'md');
    const from = before.length;
    const to = from + 'PLACEHOLDER'.length;
    const out = applySourcePatches(d, 0, [{ from, to, insert: encoded, expected: 'PLACEHOLDER' }]);
    expect(out.text).toBe(before + encoded + after);
    expect(out.text).toContain('\\# Not a heading');
  });

  test('rejects bad input', () => {
    expect(() => encodeProseText(42 as unknown as string, 'md')).toThrow(/string/i);
    expect(() => encodeProseText('x', 'txt' as unknown as 'md')).toThrow(/format/i);
  });
});
