import { expect, test } from 'bun:test';
import { LABEL_GAP, paddedCutout, quoteNativeMaskReference, uniqueMaskId } from './svgMask';

const same = (...ids: string[]) => new Map(ids.map(id => [id, id]));

test('native local mask references quote punctuation without changing target IDs', () => {
  const id = 'mask-d2:(a -> b)[0]';
  expect(quoteNativeMaskReference(`url(#${id})`, same(id))).toBe(`url("#${id}")`);
  const escapedId = 'mask-node "quoted"\\path';
  expect(quoteNativeMaskReference(`url(#${escapedId})`, same(escapedId))).toBe('url("#mask-node \\"quoted\\"\\\\path")');
  expect(quoteNativeMaskReference('url(#line\nbreak)', same('line\nbreak'))).toBe('url("#line\\a break")');
});

test('unknown, external, already quoted and unrelated references are unchanged', () => {
  const ids = same('mask-d2:(a -> b)[0]');
  for (const value of ['url(#unknown)', 'url(https://example.test/#mask)', 'url("#mask-d2:(a -> b)[0]")', 'none']) {
    expect(quoteNativeMaskReference(value, ids)).toBe(value);
  }
});

test('a reference follows its mask to the mask\'s new id', () => {
  const renamed = new Map([['mask-d2:(a -> b)[0]', 'mask-d2:(a -> b)[0]-k3x9']]);
  expect(quoteNativeMaskReference('url(#mask-d2:(a -> b)[0])', renamed)).toBe('url("#mask-d2:(a -> b)[0]-k3x9")');
});

test('the same arrow id in two diagrams gets two mask ids, and the same mask keeps one', () => {
  const id = 'mask-d2:(a -> b)[0]';
  const across = '<rect x="0" y="0" fill="#fff" width="381" height="143"></rect><rect x="134" y="33" fill="#000" width="82" height="20"></rect>';
  const down = '<rect x="0" y="0" fill="#fff" width="284" height="342"></rect><rect x="54.75" y="106" fill="#000" width="38" height="20"></rect>';
  expect(uniqueMaskId(id, across)).not.toBe(uniqueMaskId(id, down));
  expect(uniqueMaskId(id, across)).toBe(uniqueMaskId(id, across));
  expect(uniqueMaskId(id, across).startsWith(`${id}-`)).toBe(true);
});

test('a label\'s cutout keeps the canvas\'s gap around the words', () => {
  expect(paddedCutout({ x: 134, y: 33, width: 82, height: 20 })).toEqual({
    x: 134 - LABEL_GAP,
    y: 33 - LABEL_GAP,
    width: 82 + 2 * LABEL_GAP,
    height: 20 + 2 * LABEL_GAP,
  });
  expect(LABEL_GAP).toBe(5);
});
