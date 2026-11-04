import { expect, test } from 'bun:test';
import { prepareVisibleAssets } from './progressiveAssets';

const deferred = () => {
  let resolve!: () => void;
  return {promise: new Promise<void>(done => {resolve = done;}), release: () => resolve()};
};

test('later ready assets publish while an earlier asset is blocked, with bounded concurrency', async () => {
  const first = deferred(), second = deferred();
  const started: number[] = [], ready: number[] = [];
  const run = prepareVisibleAssets([1, 2, 3, 4], new AbortController().signal, async item => {
    started.push(item);
    if (item === 1) await first.promise;
    if (item === 2) await second.promise;
    ready.push(item);
  }, 2);
  expect(started).toEqual([1, 2]);
  second.release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(ready).toEqual([2, 3, 4]);
  first.release();
  await run;
  expect(ready).toEqual([2, 3, 4, 1]);
});

test('a failed asset does not stop independent assets and cancellation stops queued work', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  await prepareVisibleAssets([1, 2, 3], controller.signal, async item => {
    started.push(item);
    if (item === 1) throw new Error('unavailable');
    controller.abort();
  }, 1);
  expect(started).toEqual([1, 2]);
});
