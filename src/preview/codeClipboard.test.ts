import { describe, expect, test } from 'bun:test';
import { CodeClipboard, handleCodeCopyRequest } from './codeClipboard';
import { MAX_CODE_COPY_TEXT_LENGTH, type CodeCopyResult } from '../features/rendered/protocol';

const FRAME = {};
const request = { kind: 'copy-code', session: 'session-test', revision: 3, request: 4, text: 'const x = "<>&";\n\n' } as const;

function parent() {
  const answers: CodeCopyResult[] = [];
  const writes: string[] = [];
  const port = { postMessage: (message: CodeCopyResult) => answers.push(message) };
  const args = {
    data: request as unknown,
    source: FRAME as unknown,
    expectedSource: FRAME as unknown,
    session: request.session,
    revision: request.revision,
    port,
    currentPort: () => port as typeof port | null,
    activation: { isActive: true },
    writeText: (text: string) => { writes.push(text); return Promise.resolve(); },
  };
  return { args, answers, writes, port };
}

describe('trusted code clipboard handler', () => {
  test('calls native text write synchronously, then acknowledges only its result', async () => {
    const { args, answers, writes } = parent();
    handleCodeCopyRequest(args);
    expect(writes).toEqual([request.text]);
    expect(answers).toEqual([]);
    await Promise.resolve();
    expect(answers).toEqual([{ kind: 'code-copy-result', session: request.session, request: 4, ok: true }]);
  });

  test('rejects inactive gestures without touching the clipboard', () => {
    const { args, answers, writes } = parent();
    handleCodeCopyRequest({ ...args, activation: { isActive: false } });
    expect(writes).toEqual([]);
    expect(answers[0]?.ok).toBe(false);
  });

  test('leaves unsupported activation detection to the native clipboard API', async () => {
    const { args, answers, writes } = parent();
    handleCodeCopyRequest({ ...args, activation: undefined });
    expect(writes).toEqual([request.text]);
    await Promise.resolve();
    expect(answers[0]?.ok).toBe(true);
  });

  test('unknown senders, stale sessions/revisions and malformed requests never write or reply', async () => {
    const { args, answers, writes } = parent();
    for (const invalid of [
      { ...args, source: {} }, { ...args, expectedSource: null },
      { ...args, session: 'session-other' }, { ...args, revision: 4 },
      { ...args, data: { ...request, text: [] } },
      { ...args, data: { ...request, html: '<b>no</b>' } },
      { ...args, data: { ...request, text: 'x'.repeat(MAX_CODE_COPY_TEXT_LENGTH + 1) } },
      { ...args, currentPort: () => null },
    ]) handleCodeCopyRequest(invalid);
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(answers).toEqual([]);
  });

  test('native denial and synchronous failure return no platform details', async () => {
    for (const writeText of [
      () => Promise.reject(new Error('secret platform detail')),
      () => { throw new Error('secret platform detail'); },
    ]) {
      const { args, answers } = parent();
      handleCodeCopyRequest({ ...args, writeText });
      await Promise.resolve();
      expect(answers).toEqual([{ kind: 'code-copy-result', session: request.session, request: 4, ok: false }]);
    }
  });

  test('an async completion never posts to a replaced or closed frame', async () => {
    const { args, answers, port } = parent();
    let current: typeof port | null = port;
    let finish!: () => void;
    handleCodeCopyRequest({ ...args, currentPort: () => current, writeText: () => new Promise<void>(resolve => { finish = resolve; }) });
    current = null;
    finish();
    await Promise.resolve();
    expect(answers).toEqual([]);
  });
});

describe('frame code clipboard requests', () => {
  test('posts immediately, preserves text, and correlates out-of-order replies', async () => {
    const sent: unknown[] = [];
    const client = new CodeClipboard(() => ({ session: 'session-test', revision: 3 }), message => { sent.push(message); return true; });
    const first = client.copy(request.text);
    const second = client.copy('second');
    expect(sent).toEqual([{ ...request, request: 0 }, { ...request, request: 1, text: 'second' }]);
    client.receive({ kind: 'code-copy-result', session: 'session-test', request: 1, ok: true });
    await second;
    client.receive({ kind: 'code-copy-result', session: 'session-test', request: 0, ok: false });
    await expect(first).rejects.toThrow('Code could not be copied.');
  });

  test('malformed, unknown and stale-session replies cannot settle another request', async () => {
    const client = new CodeClipboard(() => ({ session: 'session-test', revision: 3 }), () => true, 5);
    const copied = client.copy('code');
    for (const data of [
      { kind: 'code-copy-result', session: 'session-test', request: 0, ok: 'yes' },
      { kind: 'code-copy-result', session: 'session-other', request: 0, ok: true },
      { kind: 'code-copy-result', session: 'session-test', request: 5, ok: true },
      { kind: 'code-copy-result', session: 'session-test', request: 0, ok: true, error: 'untrusted' },
    ]) client.receive(data);
    await expect(copied).rejects.toThrow('Code could not be copied.');
  });

  test('request count, text bytes and uninitialized contexts are bounded', async () => {
    const sent: unknown[] = [];
    const client = new CodeClipboard(() => ({ session: 'session-test', revision: 3 }), message => { sent.push(message); return true; });
    const pending = Array.from({ length: 16 }, () => client.copy('code'));
    await expect(client.copy('overflow')).rejects.toThrow();
    expect(sent).toHaveLength(16);
    pending.forEach((_, request) => client.receive({ kind: 'code-copy-result', session: 'session-test', request, ok: true }));
    await Promise.all(pending);
    await expect(client.copy('x'.repeat(MAX_CODE_COPY_TEXT_LENGTH + 1))).rejects.toThrow();
    const uninitialized = new CodeClipboard(() => ({ session: null, revision: -1 }), () => true);
    await expect(uninitialized.copy('code')).rejects.toThrow();
  });

  test('a missing connection or failed post rejects immediately', async () => {
    for (const post of [() => false, () => { throw new Error('closed'); }]) {
      const client = new CodeClipboard(() => ({ session: 'session-test', revision: 3 }), post);
      await expect(client.copy('code')).rejects.toThrow('Code could not be copied.');
    }
  });
});
