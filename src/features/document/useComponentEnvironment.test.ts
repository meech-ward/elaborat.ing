import { describe, expect, test } from 'bun:test';
import { watchSavedModules } from './useComponentEnvironment';

/** A device store: `saved` holds each file's saved revision; `notify` is any change on the device. */
function device(saved: Record<string, string | null>) {
  const listeners = new Set<() => void>();
  const reads: string[] = [];
  return {
    saved,
    reads,
    subscribe: (listener: () => void) => {listeners.add(listener);return () => {listeners.delete(listener);};},
    load: async (path: string) => {
      reads.push(path);
      const revision = saved[path];
      if (revision === undefined || revision === null) throw new Error(`${path} has no saved copy`);
      return {text:`text of ${revision}`,revision};
    },
    notify: () => {for (const listener of [...listeners]) listener();},
    listeners,
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve,0));

describe('watchSavedModules', () => {
  test('a module saved with new bytes rebuilds once; other changes never do', async () => {
    const store = device({'card.mdx':'r1','other.mdx':'x1'});
    let changes = 0;
    watchSavedModules(store.subscribe,new Map([['card.mdx','r1']]),store.load,() => changes++);

    store.saved['other.mdx'] = 'x2';
    store.notify();
    await settle();
    expect(changes).toBe(0);
    expect(store.reads).toEqual(['card.mdx']);

    store.saved['card.mdx'] = 'r2';
    store.notify();
    store.notify();
    await settle();
    store.notify();
    await settle();
    expect(changes).toBe(1);
  });

  test('a module that could not be read is watched until it can be', async () => {
    const store = device({'card.mdx':null});
    let changes = 0;
    watchSavedModules(store.subscribe,new Map([['card.mdx',null]]),store.load,() => changes++);
    store.notify();
    await settle();
    expect(changes).toBe(0);
    store.saved['card.mdx'] = 'r1';
    store.notify();
    await settle();
    expect(changes).toBe(1);
  });

  test('a module that becomes unreadable counts as changed', async () => {
    const store = device({'card.mdx':'r1'});
    let changes = 0;
    watchSavedModules(store.subscribe,new Map([['card.mdx','r1']]),store.load,() => changes++);
    delete store.saved['card.mdx'];
    store.notify();
    await settle();
    expect(changes).toBe(1);
  });

  test('stopping unsubscribes, and a check still running reports nothing', async () => {
    const store = device({'card.mdx':'r1'});
    let changes = 0;
    const stop = watchSavedModules(store.subscribe,new Map([['card.mdx','r1']]),store.load,() => changes++);
    store.saved['card.mdx'] = 'r2';
    store.notify();
    stop();
    await settle();
    expect(changes).toBe(0);
    expect(store.listeners.size).toBe(0);
  });

  test('revisions recorded after the watch starts are checked too', async () => {
    const store = device({'card.mdx':'r1'});
    const revisions = new Map<string, string | null>();
    let changes = 0;
    watchSavedModules(store.subscribe,revisions,store.load,() => changes++);
    revisions.set('card.mdx','r1');
    store.saved['card.mdx'] = 'r2';
    store.notify();
    await settle();
    expect(changes).toBe(1);
  });
});
