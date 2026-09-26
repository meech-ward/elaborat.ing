import { expect, test } from 'bun:test';
import { quoteNativeMaskReference } from './svgMask';

test('native local mask references quote punctuation without changing target IDs', () => {
  const id = 'mask-d2:(a -> b)[0]';
  expect(quoteNativeMaskReference(`url(#${id})`, [id])).toBe(`url("#${id}")`);
  const escapedId = 'mask-node "quoted"\\path';
  expect(quoteNativeMaskReference(`url(#${escapedId})`, [escapedId])).toBe('url("#mask-node \\"quoted\\"\\\\path")');
  expect(quoteNativeMaskReference('url(#line\nbreak)', ['line\nbreak'])).toBe('url("#line\\a break")');
});

test('unknown, external, already quoted and unrelated references are unchanged', () => {
  const ids = ['mask-d2:(a -> b)[0]'];
  for (const value of ['url(#unknown)', 'url(https://example.test/#mask)', 'url("#mask-d2:(a -> b)[0]")', 'none']) {
    expect(quoteNativeMaskReference(value, ids)).toBe(value);
  }
});
