import { expect, test } from 'bun:test';
import { isReadOnly, setReadOnly, subscribeReadOnly } from './readOnly';

test('read-only tells its subscribers when it changes, and only then', () => {
  const seen: boolean[] = [];
  const stop = subscribeReadOnly(() => seen.push(isReadOnly()));
  setReadOnly(true);
  setReadOnly(true);
  setReadOnly(false);
  stop();
  setReadOnly(true);
  expect(seen).toEqual([true, false]);
  setReadOnly(false);
});
