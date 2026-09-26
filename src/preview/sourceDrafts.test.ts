import { expect, test } from 'bun:test';
import { SourceDraftStore, rebaseDraftRegion } from './sourceDrafts';

const region = { from: 20, to: 24, expected: 'Body' };
const body = (revision = 1) => ({ kind: 'prose-edit' as const, session: 'session-test', revision, ...region, value: 'Body edited' });

test('range rebasing permits disjoint offsets and refuses overlap', () => {
  expect(rebaseDraftRegion(region, [{ from: 3, to: 8, insertLength: 9 }])).toEqual({ ...region, from: 24, to: 28 });
  expect(rebaseDraftRegion(region, [{ from: 22, to: 22, insertLength: 2 }])).toBeNull();
  expect(rebaseDraftRegion(region, [{ from: 19, to: 21, insertLength: 0 }])).toBeNull();
});

test('title, body and code edits serialize against each acknowledged compiled source range', () => {
  const sent: unknown[] = [], store = new SourceDraftStore(message => sent.push(message));
  const code = { from: 40, to: 44, expected: 'Code' };
  store.beginRender('session-test', 1); store.finishRender([region, code]);
  store.queue({ kind: 'component-value-edit', session: 'session-test', revision: 1, slot: 0, prop: 'title', value: 'Changed title' });
  store.capture(region, { value: 'Body edited', start: 11, end: 11, focused: false }, 'Body');
  store.queue(body());
  store.capture(code, { value: 'Code edited', start: 11, end: 11, focused: true }, 'Code');
  store.queue({ ...body(), ...code, value: 'Code edited' });
  expect(sent).toHaveLength(1);
  store.beginRender('session-test', 2, { fromRevision: 1, draftId: 1, patches: [{ from: 4, to: 4, insertLength: 5 }] });
  const moved = { ...region, from: 25, to: 29 };
  expect(store.get(moved)?.value).toBe('Body edited');
  expect(sent).toHaveLength(1);
  store.finishRender([moved, { ...code, from: 45, to: 49 }]);
  expect(sent[1]).toEqual({ ...body(), ...moved, revision: 2, draftId: 2 });
  store.beginRender('session-test', 3, { fromRevision: 2, draftId: 2, patches: [{ from: 25, to: 29, insertLength: 11 }] });
  const movedCode = { ...code, from: 52, to: 56 };
  store.finishRender([{ from: 25, to: 36, expected: 'Body edited' }, movedCode]);
  expect(sent[2]).toEqual({ ...body(), ...movedCode, value: 'Code edited', revision: 3, draftId: 3 });
  store.beginRender('session-test', 4, { fromRevision: 3, draftId: 3, patches: [{ from: 52, to: 56, insertLength: 11 }] });
  store.finishRender([{ from: 25, to: 36, expected: 'Body edited' }, { from: 52, to: 63, expected: 'Code edited' }]);
  expect(store.recovery).toEqual([]);
});

test('external revisions and mismatched new baselines retain drafts without sending stale edits', () => {
  for (const external of [true, false]) {
    const sent: unknown[] = [], store = new SourceDraftStore(message => sent.push(message));
    store.beginRender('session-test', 1); store.finishRender([region]);
    store.queue({ kind: 'component-value-edit', session: 'session-test', revision: 1, slot: 0, prop: 'title', value: 'Title' });
    store.capture(region, { value: 'Body edited', start: 11, end: 11, focused: true }, 'Body');
    store.queue(body());
    store.beginRender('session-test', 2, external ? undefined : { fromRevision: 1, patches: [] });
    store.finishRender([{ ...region, expected: 'Else' }]);
    expect(sent).toHaveLength(1);
    expect(store.recovery.some(draft => draft.value === 'Body edited')).toBe(true);
    expect(store.get(region)).toBeUndefined();
  }
});

test('Escape baseline clears an unsent draft and stale callers cannot submit', () => {
  const sent: unknown[] = [], store = new SourceDraftStore(message => sent.push(message));
  store.beginRender('session-test', 2); store.finishRender([region]);
  store.capture(region, { value: 'Body edited', start: 0, end: 0, focused: true }, 'Body');
  store.capture(region, { value: 'Body', start: 0, end: 0, focused: false }, 'Body');
  expect(store.get(region)).toBeUndefined();
  store.queue(body(1));
  expect(sent).toEqual([]);
  expect(store.recovery[0].value).toBe('Body edited');
});

test('a newly focused unchanged field keeps its caret across a disjoint acknowledgement', () => {
  const store = new SourceDraftStore(() => {});
  store.beginRender('session-test', 1); store.finishRender([region]);
  store.capture(region, { value: 'Body', start: 2, end: 2, focused: true }, 'Body');
  store.beginRender('session-test', 2, { fromRevision: 1, patches: [{ from: 0, to: 0, insertLength: 3 }] });
  const moved = { ...region, from: 23, to: 27 };
  store.finishRender([moved]);
  expect(store.get(moved)).toMatchObject({ value: 'Body', start: 2, end: 2, focused: true });
  expect(store.recovery).toEqual([]);
});

test('pending covers the serialized queue and explicit rejection retains input while unblocking it', () => {
  const states: boolean[] = [], sent: unknown[] = [];
  const store = new SourceDraftStore(message => sent.push(message), pending => states.push(pending));
  store.beginRender('session-test', 1); store.finishRender([region]);
  store.queue(body());
  expect(states.at(-1)).toBe(true);
  store.settle(99, 'rejected', 'Unrelated reply.');
  expect(states.at(-1)).toBe(true);
  store.settle(1, 'rejected', 'Source refused the edit.');
  expect(states.at(-1)).toBe(false);
  expect(store.recovery[0].value).toBe('Body edited');
});

test('a body acknowledgement releases an omitted title only when its fresh supported component matches', () => {
  const original = [{ index: 0, element: 'Note', supported: true }];
  for (const next of [original, [], [{ index: 0, element: 'Warning', supported: true }], [{ index: 0, element: 'Note', supported: false }]]) {
    const sent: unknown[] = [], store = new SourceDraftStore(message => sent.push(message));
    store.beginRender('session-test', 1, undefined, original); store.finishRender([region]);
    store.queue(body());
    store.queue({ kind: 'component-value-edit', session: 'session-test', revision: 1, slot: 0, prop: 'title', value: 'New title' });
    expect(sent).toHaveLength(1);
    store.beginRender('session-test', 2, { fromRevision: 1, draftId: 1, patches: [{ from: 20, to: 24, insertLength: 11 }] }, next);
    store.finishRender([{ from: 20, to: 31, expected: 'Body edited' }]);
    if (next === original) {
      expect(sent[1]).toMatchObject({ kind: 'component-value-edit', draftId: 2, revision: 2, value: 'New title' });
      expect(store.recovery).toEqual([]);
    } else {
      expect(sent).toHaveLength(1);
      expect(store.recovery.some(draft => draft.value === 'New title')).toBe(true);
    }
  }
});

test('an active omitted-title draft survives a body ack and its own insertion ack clears it', () => {
  const sent: unknown[] = [], store = new SourceDraftStore(message => sent.push(message));
  const slots = [{ index: 0, element: 'Note', supported: true }];
  const anchor = { from: 5, to: 5, expected: '' };
  store.beginRender('session-test', 1, undefined, slots); store.finishRender([region, anchor]);
  store.queue(body());
  store.capture(anchor, { value: 'My title', start: 8, end: 8, focused: true }, 'Note');
  store.beginRender('session-test', 2, { fromRevision: 1, draftId: 1, patches: [{ from: 20, to: 24, insertLength: 11 }] }, slots);
  store.finishRender([{ from: 20, to: 31, expected: 'Body edited' }, anchor]);
  expect(store.get(anchor)).toMatchObject({ value: 'My title', focused: true, start: 8 });
  store.queue({ kind: 'component-value-edit', session: 'session-test', revision: 2, slot: 0, prop: 'title', value: 'My title' }, 'My title', anchor);
  store.beginRender('session-test', 3, { fromRevision: 2, draftId: 2, patches: [{ from: 5, to: 5, insertLength: 17 }] }, slots);
  store.finishRender([{ from: 12, to: 22, expected: '"My title"' }]);
  expect(store.get(anchor)).toBeUndefined();
  expect(store.recovery).toEqual([]);
});
