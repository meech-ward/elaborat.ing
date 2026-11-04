import { describe, expect, test } from 'bun:test';
import { holdsNoCode, reusedEnvironment, watchSavedModules, retainSourceCatalog } from './useComponentEnvironment';

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
    await settle();
    expect(store.reads).toEqual(['card.mdx']);
    store.reads.length = 0;

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

describe('component preparation document identity', () => {
  test('ordinary typing keeps its last good environment without making the frame pending', async () => {
    const { componentPreparationForIdentity } = await import('./useComponentEnvironment');
    const { prepareComponentEnvironment } = await import('./componentModules');
    const environment = await prepareComponentEnvironment('# Before the next keystroke\n');
    const shown = componentPreparationForIdentity({ environment, settled: true, identity: 1 }, 1);
    expect(shown.environment).toBe(environment);
    expect(shown.pending).toBe(false);
  });

  test('a replacement never exposes the old document environment or error', async () => {
    const { componentPreparationForIdentity } = await import('./useComponentEnvironment');
    const { prepareComponentEnvironment } = await import('./componentModules');
    const environment = await prepareComponentEnvironment('export const Old = () => <p>Previous document</p>\n');
    expect(componentPreparationForIdentity({ environment, settled: true, error: 'Previous error', identity: 1 }, 2)).toEqual({ pending: true });
    const shown = componentPreparationForIdentity({ environment, settled: true, identity: 2 }, 2);
    expect(shown.environment).toBe(environment);
    expect(shown.pending).toBe(false);
  });
});

describe('typing prose into a note with no code', () => {
  const PLAIN = [
    '# Notes\n\nFirst paragraph.\n',
    '---\ntitle: Plan\n---\n\n# Plan\n\n- one\n- two\n',
    '<Callout type="info">A built-in component with a literal prop</Callout>\n\nText after.\n',
    '```js\nconst value = 1;\n```\n\nImportance and exports are just words here.\n',
    '<Counter />\n\n<img src="images/a.png" alt="A" />\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  ];
  const CODE = [
    'Text with {1 + 1}.\n',
    '<Chart data={[1, 2]} />\n',
    "import { Card } from 'workspace:card.mdx'\n\n<Card />\n",
    'export const Local = () => <p>Local</p>\n\n<Local />\n',
    "   import { useState } from 'react'\n",
    '{/* a comment */}\n',
    '\uFEFFexport const Local = () => <p>Local</p>\n\n<Local />\n',
    "Intro.\r\nexport const Local = () => <p>Local</p>\r\n",
  ];

  test('text is plain prose only without a brace and without a line that could start an import or export', () => {
    for (const text of PLAIN) expect(holdsNoCode(text)).toBe(true);
    for (const text of CODE) expect(holdsNoCode(text)).toBe(false);
    expect(holdsNoCode('a'.repeat(800_000))).toBe(false);
  });

  test('text it calls plain never compiles to code, whatever comes before an import or export', async () => {
    const { prepareComponentEnvironment } = await import('./componentModules');
    const prefixes = ['', '\uFEFF', '\uFEFF\uFEFF', ' ', '    ', '\t', '\u200B', '\u00A0', '\n', '\r\n', '> ', '- ', 'Intro.\n', '---\ntitle: x\n---\n'];
    const bodies = ['export const Local = () => <p>Local</p>\n\n<Local />\n', "import Card from 'workspace:card.mdx'\n", 'export default function Page() { return null }\n', 'Text.\n'];
    for (const prefix of prefixes) for (const body of bodies) {
      const text = prefix + body;
      if (!holdsNoCode(text)) continue;
      const environment = await prepareComponentEnvironment(text).catch(() => null);
      expect({ text, code: environment?.code ?? [], modules: environment?.modules ?? [] }).toEqual({ text, code: [], modules: [] });
    }
  });

  test('plain prose compiles to the built-in catalog itself, with no code and no modules', async () => {
    const { prepareComponentEnvironment } = await import('./componentModules');
    const { COMPONENT_CATALOG } = await import('./componentCatalog');
    for (const text of PLAIN) {
      const environment = await prepareComponentEnvironment(text);
      expect(environment.catalog).toBe(COMPONENT_CATALOG);
      expect([environment.code, environment.modules, environment.key]).toEqual([[], [], '']);
    }
  });

  test('the last environment serves the next plain text, with that text as its source, exactly as a compile of it would', async () => {
    const { prepareComponentEnvironment } = await import('./componentModules');
    const loader = async () => ({ text: '', revision: 'r1' });
    const environment = await prepareComponentEnvironment(PLAIN[0], loader);
    const state = { environment, loader, settled: true, identity: 4 };
    for (const text of PLAIN) {
      const reused = reusedEnvironment(state, 4, loader, text);
      expect(reused).toEqual(await prepareComponentEnvironment(text, loader));
      expect(reused?.catalog).toBe(environment.catalog);
    }
    expect(reusedEnvironment(state, 4, loader, PLAIN[0])).toBe(environment);
  });

  test('a compile is still made for code, another document, another loader, an error or an environment with code', async () => {
    const { prepareComponentEnvironment } = await import('./componentModules');
    const loader = async () => ({ text: '', revision: 'r1' });
    const environment = await prepareComponentEnvironment(PLAIN[0], loader);
    const state = { environment, loader, settled: true, identity: 4 };
    for (const text of CODE) expect(reusedEnvironment(state, 4, loader, text)).toBeNull();
    expect(reusedEnvironment(state, 5, loader, PLAIN[1])).toBeNull();
    expect(reusedEnvironment(state, 4, async () => ({ text: '', revision: 'r2' }), PLAIN[1])).toBeNull();
    expect(reusedEnvironment({ ...state, error: 'Unexpected end of file' }, 4, loader, PLAIN[1])).toBeNull();
    expect(reusedEnvironment({ ...state, settled: false }, 4, loader, PLAIN[1])).toBeNull();
    const withCode = await prepareComponentEnvironment('Text with {Math.max(1, 2)}.\n', loader);
    expect(withCode.code.length).toBeGreaterThan(0);
    expect(reusedEnvironment({ ...state, environment: withCode }, 4, loader, PLAIN[1])).toBeNull();
  });
});


test('late valid Source catalogs stay metadata-only and cannot replace newer document or loader results', async () => {
  const {prepareComponentEnvironment} = await import('./componentModules');
  const loader = async () => ({text:'export const Release = () => <p>Release</p>',revision:'module-1'});
  const environment = await prepareComponentEnvironment('import { Release } from "workspace:release.mdx"\n',loader);
  const result = {identity:7,loader,sequence:1,catalog:environment.catalog};
  const scope = {identity:7,loader,live:true};
  const remembered = retainSourceCatalog(null,result,scope);
  expect(remembered?.catalog.some(component => component.name === 'Release')).toBe(true);
  const {completeSource} = await import('../source/completions');
  expect(completeSource({text:'<Rel',offset:4,language:'mdx',componentCatalog:remembered?.catalog}).map(item => item.label)).toContain('Release');
  expect(remembered).not.toHaveProperty('environment');
  expect(remembered).not.toHaveProperty('modules');
  expect(remembered).not.toHaveProperty('code');
  const newer = {...result,sequence:3};
  expect(retainSourceCatalog(newer,result,scope)).toBe(newer);
  expect(retainSourceCatalog(null,result,{...scope,identity:8})).toBeNull();
  expect(retainSourceCatalog(null,result,{...scope,loader:async () => ({text:'',revision:'account-2'})})).toBeNull();
  expect(retainSourceCatalog(null,result,{...scope,live:false})).toBeNull();
});


test('resuming a saved-module watcher detects changes made during the inactive interval exactly once', async () => {
  const store = device({'card.mdx':'r1','other.mdx':'other-1'});
  const revisions = new Map([['card.mdx','r1']]);
  let changes = 0;
  const stop = watchSavedModules(store.subscribe,revisions,store.load,() => changes++);
  await settle();
  expect(changes).toBe(0);
  stop();
  store.reads.length = 0;
  store.saved['card.mdx'] = 'r2';
  store.notify();
  await settle();
  expect(store.reads).toEqual([]);
  const resumed = watchSavedModules(store.subscribe,revisions,store.load,() => changes++);
  await settle();
  expect(changes).toBe(1);
  expect(store.reads).toEqual(['card.mdx']);
  store.notify();
  await settle();
  expect(changes).toBe(1);
  expect(store.reads).toEqual(['card.mdx']);
  resumed();
  const current = watchSavedModules(store.subscribe,new Map([['card.mdx','r2']]),store.load,() => changes++);
  await settle();
  store.saved['other.mdx'] = 'other-2';
  store.notify();
  await settle();
  expect(changes).toBe(1);
  current();
});
