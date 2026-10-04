/**
 * Focused tests for the parent/child frame protocol.
 *
 * Invariants under test:
 * - Unknown senders are rejected even with a well-formed message.
 * - Session and revision must match; stale revisions fail visibly.
 * - Malformed shapes are rejected.
 * - `ready` passes before the child knows the session (sender-gated).
 * - The frame takes exactly one port, only from its embedder, only once.
 * - The sandbox constant never grants same-origin or privileged flags.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkChildMessage,
  checkConnectMessage,
  checkEditResource,
  checkParentMessage,
  checkPropEdit,
  checkProseEdit,
  checkViewResource,
  encodePropLiteral,
  literalMatchesKind,
  parseExpressionLiteral,
  PREVIEW_CHILD_CSP,
  PREVIEW_SANDBOX,
  staleChildMessage,
  type ChildMessage,
  type SlotRange,
} from './protocol';

const FRAME = { id: 'frame' };
const OTHER = { id: 'other' };

function proseEdit() {
  return {
    kind: 'prose-edit',
    session: 'session-1234',
    revision: 7,
    from: 10,
    to: 15,
    expected: 'Hello',
    value: 'Goodbye',
  };
}

describe('checkConnectMessage', () => {
  test('the frame takes one port from its embedder, once, with nothing else in the message', () => {
    const port = { id: 'port' };
    const valid = { data: { kind: 'connect' }, source: FRAME, parent: FRAME, ports: [port], connected: false };
    expect(checkConnectMessage(valid)).toBe(port);
    for (const invalid of [
      { ...valid, source: OTHER },
      { ...valid, source: null, parent: null },
      { ...valid, connected: true },
      { ...valid, ports: [] },
      { ...valid, ports: [port, { id: 'second' }] },
      { ...valid, data: { kind: 'connect', session: 'session-1234' } },
      { ...valid, data: { kind: 'render' } },
      { ...valid, data: null },
    ]) expect(checkConnectMessage(invalid)).toBeNull();
  });
});

describe('checkChildMessage', () => {
  test('queued edit ids and independent draft-pending state retain sender/session/revision guards', () => {
    const messages = [
      { ...proseEdit(), draftId: 4 },
      { kind: 'prop-edit', session: 'session-1234', revision: 7, draftId: 4, slot: 0, prop: 'title', from: 1, to: 4, expected: '"x"', literal: '"y"' },
      { kind: 'component-value-edit', session: 'session-1234', revision: 7, draftId: 4, slot: 0, prop: 'title', value: 'Title' },
      { kind: 'source-draft-pending', session: 'session-1234', revision: 7, pending: true },
    ];
    for (const data of messages) {
      const valid = { data, source: FRAME, expectedSource: FRAME, session: 'session-1234', revision: 7 };
      const result = checkChildMessage(valid);
      expect(result.ok).toBe(true);
      if (result.ok && 'draftId' in data) expect('draftId' in result.message && result.message.draftId).toBe(4);
      expect(checkChildMessage({ ...valid, source: OTHER }).ok).toBe(false);
      expect(checkChildMessage({ ...valid, session: 'another-session' }).ok).toBe(false);
      expect(checkChildMessage({ ...valid, revision: 8 }).ok).toBe(false);
      if ('draftId' in data) expect(checkChildMessage({ ...valid, data: { ...data, draftId: -1 } }).ok).toBe(false);
    }
  });
  test('nonfatal edit rejection still requires the current sender, session, revision and bounded message', () => {
    const valid = {
      data: { kind: 'edit-rejected', session: 'session-1234', revision: 7, message: 'Selection crosses computed output.' },
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    };
    expect(checkChildMessage(valid).ok).toBe(true);
    for (const invalid of [
      { ...valid, source: OTHER },
      { ...valid, session: 'another-session' },
      { ...valid, revision: 8 },
      { ...valid, data: { ...valid.data, message: 'x'.repeat(2001) } },
    ]) expect(checkChildMessage(invalid).ok).toBe(false);
  });
  test('accepts a well-formed edit from the known frame', () => {
    const result = checkChildMessage({
      data: proseEdit(),
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    });
    expect(result.ok).toBe(true);
  });

  test('rejects messages from an unknown sender', () => {
    const result = checkChildMessage({
      data: proseEdit(),
      source: OTHER,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown sender/i);
  });

  test('rejects a stale session', () => {
    const result = checkChildMessage({
      data: proseEdit(),
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-9999',
      revision: 7,
    });
    expect(result.ok).toBe(false);
  });

  test('rejects a stale revision so old frames cannot overwrite', () => {
    const result = checkChildMessage({
      data: proseEdit(),
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 8,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stale/i);
  });

  test('rejects malformed shapes', () => {
    const result = checkChildMessage({
      data: { kind: 'prose-edit', session: 'session-1234' },
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    });
    expect(result.ok).toBe(false);
  });

  test('ready passes sender-gated before the session is known', () => {
    const result = checkChildMessage({
      data: { kind: 'ready', session: 'pending' },
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    });
    expect(result.ok).toBe(true);
  });
});

describe('frame modules', () => {
  test('the frame asks for a known module of its own code, at any revision of the note', () => {
    const valid = { data: { kind: 'load-module', session: 'session-1234', name: 'charts' }, source: FRAME, expectedSource: FRAME, session: 'session-1234', revision: 7 };
    expect(checkChildMessage(valid).ok).toBe(true);
    expect(checkChildMessage({ ...valid, revision: 8 }).ok).toBe(true);
    expect(checkChildMessage({ ...valid, data: { ...valid.data, name: 'highlighter' } }).ok).toBe(true);
    expect(checkChildMessage({ ...valid, source: OTHER }).ok).toBe(false);
    expect(checkChildMessage({ ...valid, session: 'another-session' }).ok).toBe(false);
    for (const name of ['maps', '../charts', 'constructor']) expect(checkChildMessage({ ...valid, data: { ...valid.data, name } }).ok).toBe(false);
    expect(checkChildMessage({ ...valid, data: { ...valid.data, url: 'https://example.com/x.js' } }).ok).toBe(false);
  });

  test("the parent's answer is the module's code or why it could not load, for the frame's session", () => {
    const answer = { kind: 'module', session: 'session-1a', name: 'charts', code: 'exports.x = 1' };
    expect(checkParentMessage({ data: answer, source: {}, activeSession: 'session-1a' }).ok).toBe(true);
    expect(checkParentMessage({ data: { kind: 'module', session: 'session-1a', name: 'highlighter', error: 'Offline.' }, source: {}, activeSession: 'session-1a' }).ok).toBe(true);
    expect(checkParentMessage({ data: answer, source: {}, activeSession: null }).ok).toBe(false);
    expect(checkParentMessage({ data: answer, source: {}, activeSession: 'session-other' }).ok).toBe(false);
    expect(checkParentMessage({ data: { ...answer, name: 'maps' }, source: {}, activeSession: 'session-1a' }).ok).toBe(false);
  });
});

describe('staleChildMessage', () => {
  test('a message about an older revision is status, dropped, a refusal or a lost edit, never a render error', () => {
    const outcomes: Record<ChildMessage['kind'], ReturnType<typeof staleChildMessage>> = {
      'source-draft-pending': 'status',
      'fluid-pending': 'status',
      ready: 'drop',
      'load-module': 'drop',
      rendered: 'drop',
      'render-error': 'drop',
      'edit-resource': 'drop',
      'view-resource': 'drop',
      shortcut: 'drop',
      'comment-selection': 'drop',
      'comment-heading': 'drop',
      'comment-open': 'drop',
      'comment-markers': 'drop',
      'comment-shortcut': 'drop',
      'edit-rejected': 'refusal',
      'fluid-transaction': 'lost-edit',
      'fluid-history': 'lost-edit',
      'fluid-code-fence': 'lost-edit',
      'prose-enter': 'lost-edit',
      'block-edit': 'lost-edit',
      'insert-block': 'lost-edit',
      'prose-edit': 'lost-edit',
      'prop-edit': 'lost-edit',
      'component-value-edit': 'lost-edit',
    };
    for (const [kind, outcome] of Object.entries(outcomes)) {
      expect([kind, staleChildMessage(kind as ChildMessage['kind'])]).toEqual([kind, outcome]);
    }
  });
});

describe('checkParentMessage', () => {
  test('draft settlement and acknowledged patches preserve correlation and cannot initialize a session', () => {
    const data = { kind: 'source-draft-settled', session: 'session-1a', revision: 7, draftId: 4, outcome: 'noop' };
    expect(checkParentMessage({ data, source: {}, activeSession: 'session-1a' }).ok).toBe(true);
    expect(checkParentMessage({ data, source: {}, activeSession: null }).ok).toBe(false);
    expect(checkParentMessage({ data, source: {}, activeSession: 'session-other' }).ok).toBe(false);
    for (const invalid of [{ ...data, draftId: -1 }, { ...data, outcome: 'accepted' }, { ...data, reason: 'x'.repeat(2001) }])
      expect(checkParentMessage({ data: invalid, source: {}, activeSession: 'session-1a' }).ok).toBe(false);
    const render = checkParentMessage({
      data: { kind: 'render', session: 'session-1a', revision: 8, code: 'x', slots: [], authoring: { format: 'mdx', boundaries: [], availableResourcePaths: [], editAck: { fromRevision: 7, draftId: 4, patches: [{ from: 2, to: 4, insertLength: 8 }] } } },
      source: {}, activeSession: 'session-1a',
    });
    expect(render.ok).toBe(true);
    if (render.ok && render.message.kind === 'render') expect(render.message.authoring?.editAck?.draftId).toBe(4);
  });
  test('accepts a well-formed render for a fresh child', () => {
    const result = checkParentMessage({
      data: { kind: 'render', session: 'session-1a', revision: 0, code: 'x', slots: [] },
      source: {},
      activeSession: null,
    });
    expect(result.ok).toBe(true);
  });

  test('rejects a stale session once initialised', () => {
    const result = checkParentMessage({
      data: { kind: 'render', session: 'session-old0', revision: 0, code: 'x', slots: [] },
      source: {},
      activeSession: 'session-new0',
    });
    expect(result.ok).toBe(false);
  });

  test('rejects sourceless messages', () => {
    const result = checkParentMessage({
      data: { kind: 'render', session: 'session-1a', revision: 0, code: 'x', slots: [] },
      source: null,
      activeSession: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('resource messages', () => {
  test('resources validate by shape and never initialise a session', () => {
    const fresh = checkParentMessage({
      data: { kind: 'resources', session: 'session-1a', revision: 0, resources: [] },
      source: {},
      activeSession: null,
    });
    expect(fresh.ok).toBe(false);
    const afterRender = checkParentMessage({
      data: {
        kind: 'resources',
        session: 'session-1a',
        revision: 0,
        resources: [{ path: 'drawings/a.excalidraw', svg: '<svg></svg>' }],
      },
      source: {},
      activeSession: 'session-1a',
    });
    expect(afterRender.ok).toBe(true);
    const malformed = checkParentMessage({
      data: { kind: 'resources', session: 'session-1a', revision: 0, resources: [{ path: 'x' }] },
      source: {},
      activeSession: 'session-1a',
    });
    expect(malformed.ok).toBe(false);
  });

  test('edit-resource from the known frame validates shape; parent allowlists paths', () => {
    const result = checkChildMessage({
      data: { kind: 'edit-resource', session: 'session-1234', revision: 7, path: 'drawings/a.excalidraw' },
      source: FRAME,
      expectedSource: FRAME,
      session: 'session-1234',
      revision: 7,
    });
    expect(result.ok).toBe(true);
    // Forged paths (even from the known frame) are refused by the allowlist.
    expect(checkEditResource(['drawings/a.excalidraw'], 'drawings/a.excalidraw')).toBe(true);
    expect(checkEditResource(['drawings/a.excalidraw'], '/etc/passwd')).toBe(false);
    expect(checkEditResource(['drawings/a.excalidraw'], 'https://evil.example/x.excalidraw')).toBe(false);
    expect(checkEditResource(['drawings/a.excalidraw'], 'other/b.excalidraw')).toBe(false);
  });
});

describe('view-resource requests', () => {
  const view = (path: string) => ({
    kind: 'view-resource',
    session: 'session-1234',
    revision: 7,
    path,
  });
  const args = (data: unknown) => ({
    data,
    source: FRAME,
    expectedSource: FRAME,
    session: 'session-1234',
    revision: 7,
  });

  test('view-resource validates sender/session/revision/shape like edit-resource', () => {
    expect(checkChildMessage(args(view('drawings/a.excalidraw'))).ok).toBe(true);
    expect(checkChildMessage({ ...args(view('drawings/a.excalidraw')), source: OTHER }).ok).toBe(false);
    expect(checkChildMessage({ ...args(view('drawings/a.excalidraw')), session: 'another-session' }).ok).toBe(false);
    expect(checkChildMessage({ ...args(view('drawings/a.excalidraw')), revision: 8 }).ok).toBe(false);
    expect(checkChildMessage(args({ ...view('drawings/a.excalidraw'), path: '' })).ok).toBe(false);
    expect(checkChildMessage(args({ kind: 'view-resource', session: 'session-1234', revision: 7 })).ok).toBe(false);
  });

  test('viewing needs the source-parsed allowlist AND parent-owned pixels', () => {
    const allowed = ['drawings/a.excalidraw'];
    const pixels = { 'drawings/a.excalidraw': '<svg></svg>' };
    expect(checkViewResource(allowed, pixels, 'drawings/a.excalidraw')).toBe(true);
    // Forged or foreign paths are refused even from the known frame.
    expect(checkViewResource(allowed, pixels, '/etc/passwd')).toBe(false);
    expect(checkViewResource(allowed, pixels, 'https://evil.example/x.excalidraw')).toBe(false);
    expect(checkViewResource(allowed, pixels, 'other/b.excalidraw')).toBe(false);
    // Listed but missing pixels: no broken View action.
    expect(checkViewResource(allowed, {}, 'drawings/a.excalidraw')).toBe(false);
    expect(checkViewResource(allowed, { 'drawings/a.excalidraw': '' }, 'drawings/a.excalidraw')).toBe(false);
    expect(checkViewResource([], pixels, 'drawings/a.excalidraw')).toBe(false);
  });
});

describe('resource-focus replies', () => {
  const focus = { kind: 'resource-focus', session: 'session-1a', path: 'drawings/a.excalidraw' };
  test('focus reply validates shape and session, never initialises one', () => {
    expect(checkParentMessage({ data: focus, source: {}, activeSession: 'session-1a' }).ok).toBe(true);
    expect(checkParentMessage({ data: focus, source: {}, activeSession: null }).ok).toBe(false);
    expect(checkParentMessage({ data: focus, source: {}, activeSession: 'session-other' }).ok).toBe(false);
    expect(checkParentMessage({ data: focus, source: null, activeSession: 'session-1a' }).ok).toBe(false);
    expect(checkParentMessage({ data: { ...focus, path: '' }, source: {}, activeSession: 'session-1a' }).ok).toBe(false);
  });
});

describe('sandbox constants', () => {
  test('sandbox grants scripts only', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts');
    expect(PREVIEW_SANDBOX).not.toMatch(/allow-same-origin/);
  });

  test('child CSP forbids network and navigation', () => {
    expect(PREVIEW_CHILD_CSP).toMatch(/connect-src 'none'/);
    expect(PREVIEW_CHILD_CSP).toMatch(/form-action 'none'/);
    expect(PREVIEW_CHILD_CSP).not.toMatch(/http/);
  });

  test('child CSP allows the inline bootstrap and MDX eval, nothing remote', () => {
    expect(PREVIEW_CHILD_CSP).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(PREVIEW_CHILD_CSP).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(PREVIEW_CHILD_CSP).not.toMatch(/'self'/);
  });

  test('child CSP allows images from data: only, so a drawing\'s images show and nothing is fetched', () => {
    const img = PREVIEW_CHILD_CSP.split(';').map((part) => part.trim()).filter((part) => part.startsWith('img-src'));
    expect(img).toEqual(['img-src data:']);
    expect(PREVIEW_CHILD_CSP).not.toMatch(/blob:|https?:|\*/);
  });
});

describe('parseExpressionLiteral', () => {
  test('parses numbers, booleans and quoted strings', () => {
    expect(parseExpressionLiteral('3')).toEqual({ kind: 'number', value: 3 });
    expect(parseExpressionLiteral('true')).toEqual({ kind: 'boolean', value: true });
    expect(parseExpressionLiteral('"hi"')).toEqual({ kind: 'string', value: 'hi' });
  });

  test('rejects computed expressions', () => {
    expect(parseExpressionLiteral('count + 1')).toBeNull();
    expect(parseExpressionLiteral('{...settings}')).toBeNull();
    expect(parseExpressionLiteral('')).toBeNull();
  });
});

describe('encodePropLiteral', () => {
  test('quoted strings use entities, never backslash escapes', () => {
    expect(encodePropLiteral('quoted-double', 'string', 'A "Q" & <b>')).toBe(
      '"A &quot;Q&quot; &amp; &lt;b&gt;"',
    );
    expect(encodePropLiteral('quoted-single', 'string', "it's & fine")).toBe(
      "'it&#39;s &amp; fine'",
    );
  });

  test('braced strings use JSON escaping', () => {
    expect(encodePropLiteral('braced', 'string', 'A "Q" & more')).toBe('"A \\"Q\\" & more"');
  });

  test('numbers and booleans encode identically in both contexts', () => {
    expect(encodePropLiteral('braced', 'number', 4)).toBe('4');
    expect(encodePropLiteral('braced', 'boolean', true)).toBe('true');
    expect(() => encodePropLiteral('braced', 'number', '4' as never)).toThrow();
  });
});

describe('literalMatchesKind', () => {
  test('quoted literals keep their quotes', () => {
    expect(literalMatchesKind('quoted-double', 'string', '"hi"')).toBe(true);
    expect(literalMatchesKind('quoted-double', 'string', "'hi'")).toBe(false);
    expect(literalMatchesKind('quoted-double', 'string', 'hi')).toBe(false);
  });

  test('quoted literals must be a single literal in context (no slot escape)', () => {
    // Smuggled attribute + expression: starts/ends with a quote but breaks
    // out of its literal slot when patched into source.
    expect(
      literalMatchesKind('quoted-double', 'string', '"safe" other={dangerous()} title="again"'),
    ).toBe(false);
    expect(
      literalMatchesKind('quoted-single', 'string', "'safe' other={dangerous()} title='again'"),
    ).toBe(false);
    // A backslash does not escape a quote in a quoted attribute: the raw
    // quote still terminates the value, so this is not one literal.
    expect(literalMatchesKind('quoted-double', 'string', '"A \\"note\\""')).toBe(false);
    // Raw markup characters cannot appear in a strictly encoded literal.
    expect(literalMatchesKind('quoted-double', 'string', '"a <b>"')).toBe(false);
    expect(literalMatchesKind('quoted-double', 'string', '"a & b"')).toBe(false);
    // Entity-encoded values are still single literals.
    expect(literalMatchesKind('quoted-double', 'string', '"a &lt;b&gt; &amp; &quot;q&quot;"')).toBe(true);
  });

  test('braced literals must be exactly one literal (no concatenation)', () => {
    expect(parseExpressionLiteral('"safe" + dangerous() + "again"')).toBeNull();
    expect(literalMatchesKind('braced', 'string', '"safe" + dangerous() + "again"')).toBe(false);
    expect(parseExpressionLiteral('"unterminated')).toBeNull();
    expect(parseExpressionLiteral("'it\\'s' + x")).toBeNull();
    expect(parseExpressionLiteral('"ok"')).toEqual({ kind: 'string', value: 'ok' });
    expect(parseExpressionLiteral("'ok'")).toEqual({ kind: 'string', value: 'ok' });
  });

  test('braced literals must parse to the same kind', () => {
    expect(literalMatchesKind('braced', 'number', '4')).toBe(true);
    expect(literalMatchesKind('braced', 'number', '"4"')).toBe(false);
    expect(literalMatchesKind('braced', 'number', 'count + 1')).toBe(false);
    expect(literalMatchesKind('braced', 'string', '"ok"')).toBe(true);
  });
});

const LEAVES = [{ from: 2, to: 10, expected: 'Hi &amp; bye' }];

const SLOTS: SlotRange[] = [
  {
    index: 0,
    supported: true,
    props: [
      { name: 'initial', kind: 'number', syntax: 'braced', from: 30, to: 31, expected: '3' },
      { name: 'title', kind: 'string', syntax: 'quoted-double', from: 50, to: 60, expected: '"A note"' },
    ],
  },
  { index: 1, supported: false, props: [] },
];

describe('checkProseEdit', () => {
  test('accepts the exposed leaf byte-for-byte', () => {
    expect(checkProseEdit(LEAVES, { from: 2, to: 10, expected: 'Hi &amp; bye' })).toBe(true);
  });

  test('rejects forged ranges and decoded-entity expected text', () => {
    // Planted: evaluated document code guessing a range it was not given.
    expect(checkProseEdit(LEAVES, { from: 2, to: 11, expected: 'Hi &amp; bye!' })).toBe(false);
    // Planted: decoded children text instead of the exact source slice.
    expect(checkProseEdit(LEAVES, { from: 2, to: 10, expected: 'Hi & bye' })).toBe(false);
    expect(checkProseEdit([], { from: 2, to: 10, expected: 'Hi &amp; bye' })).toBe(false);
  });
});

describe('checkPropEdit', () => {
  test('accepts the documented literal prop', () => {
    expect(
      checkPropEdit(SLOTS, { slot: 0, prop: 'initial', literal: '4', from: 30, to: 31, expected: '3' }),
    ).toBe(true);
    expect(
      checkPropEdit(SLOTS, {
        slot: 0,
        prop: 'title',
        literal: '"New &quot;title&quot;"',
        from: 50,
        to: 60,
        expected: '"A note"',
      }),
    ).toBe(true);
  });

  test('rejects planted bad messages', () => {
    // Arbitrary JS where a number belongs.
    expect(
      checkPropEdit(SLOTS, {
        slot: 0,
        prop: 'initial',
        literal: 'count + 1',
        from: 30,
        to: 31,
        expected: '3',
      }),
    ).toBe(false);
    // A string literal smuggled into a numeric prop.
    expect(
      checkPropEdit(SLOTS, { slot: 0, prop: 'initial', literal: '"4"', from: 30, to: 31, expected: '3' }),
    ).toBe(false);
    // Forged range outside the exposed literal.
    expect(
      checkPropEdit(SLOTS, { slot: 0, prop: 'initial', literal: '4', from: 0, to: 100, expected: 'x' }),
    ).toBe(false);
    // Unknown slot, unknown prop, unsupported slot.
    expect(
      checkPropEdit(SLOTS, { slot: 9, prop: 'initial', literal: '4', from: 30, to: 31, expected: '3' }),
    ).toBe(false);
    expect(
      checkPropEdit(SLOTS, { slot: 0, prop: 'step', literal: '2', from: 30, to: 31, expected: '3' }),
    ).toBe(false);
    expect(
      checkPropEdit(SLOTS, { slot: 1, prop: 'initial', literal: '4', from: 30, to: 31, expected: '3' }),
    ).toBe(false);
    // A backslash does not escape a quote inside a quoted attribute: the
    // raw quote terminates the value, so this is not a single literal in
    // context and is refused (strict one-literal rule, see above).
    expect(
      checkPropEdit(SLOTS, {
        slot: 0,
        prop: 'title',
        literal: '"A \\"note\\""',
        from: 50,
        to: 60,
        expected: '"A note"',
      }),
    ).toBe(false);
    expect(
      checkPropEdit(SLOTS, {
        slot: 0,
        prop: 'title',
        literal: 'A note',
        from: 50,
        to: 60,
        expected: '"A note"',
      }),
    ).toBe(false);
  });
});
