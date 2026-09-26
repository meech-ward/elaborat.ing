import { expect, test } from 'bun:test';
import { indentCode } from './codeFence';

test('code Tab indents the current line without moving the caret to another line', () => {
  expect(indentCode('first\nsecond', 8, 8, false)).toEqual({ value: 'first\n  second', start: 10, end: 10 });
  expect(indentCode('  first', 1, 1, true)).toEqual({ value: 'first', start: 0, end: 0 });
  expect(indentCode('\nnext', 0, 0, false)).toEqual({ value: '  \nnext', start: 2, end: 2 });
});

test('code selection indentation and outdent preserve trailing unselected line', () => {
  const value = 'one\ntwo\nthree';
  const next = indentCode(value, 0, 8, false);
  expect(next).toEqual({ value: '  one\n  two\nthree', start: 2, end: 12 });
  expect(indentCode(next.value, next.start, next.end, true)).toEqual({ value, start: 0, end: 8 });
});
