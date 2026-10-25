import {
  checkChildMessage,
  codeCopyResultSchema,
  MAX_CODE_COPY_REQUEST,
  MAX_CODE_COPY_TEXT_LENGTH,
  type ChildMessage,
  type CodeCopyResult,
} from '../features/rendered/protocol';

type CopyRequest = Extract<ChildMessage, { kind: 'copy-code' }>;
type CopyPort = { postMessage(message: CodeCopyResult): void };

/**
 * Run on the trusted page's window-message stack, before awaiting anything:
 * WebKit preserves the initiating click here but not on a MessagePort.
 * The private port carries only a bounded success acknowledgement back.
 */
export function handleCodeCopyRequest<Port extends CopyPort>(args: {
  data: unknown;
  source: unknown;
  expectedSource: unknown;
  session: string;
  revision: number;
  port: Port;
  currentPort: () => Port | null;
  activation: { isActive: boolean } | undefined;
  writeText: (text: string) => Promise<void>;
}): void {
  const checked = checkChildMessage(args);
  if (!checked.ok || checked.message.kind !== 'copy-code' || args.currentPort() !== args.port) return;
  const { session, request, text } = checked.message;
  const answer = (ok: boolean) => {
    if (args.currentPort() !== args.port) return;
    try {
      args.port.postMessage({ kind: 'code-copy-result', session, request, ok });
    } catch {
      // The frame can close while the native clipboard operation settles.
    }
  };
  if (args.activation && !args.activation.isActive) {
    answer(false);
    return;
  }
  try {
    // Call the native operation now, not in a queued promise callback.
    args.writeText(text).then(() => answer(true), () => answer(false));
  } catch {
    answer(false);
  }
}

type PendingCopy = {
  session: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A small bounded request table. Missing/blocked parent replies time out. */
export class CodeClipboard {
  private nextRequest = 0;
  private pending = new Map<number, PendingCopy>();

  constructor(
    private context: () => { session: string | null; revision: number },
    private post: (message: CopyRequest) => boolean,
    private timeout = 10_000,
  ) {}

  // Deliberately not async: the window post stays on the trusted click's
  // stack instead of following a microtask or a permission query.
  copy(text: string): Promise<void> {
    const { session, revision } = this.context();
    if (!session || revision < 0 || text.length > MAX_CODE_COPY_TEXT_LENGTH || this.pending.size >= 16)
      return Promise.reject(new Error('Code could not be copied.'));
    let request = this.nextRequest;
    while (this.pending.has(request)) request = (request + 1) % (MAX_CODE_COPY_REQUEST + 1);
    this.nextRequest = (request + 1) % (MAX_CODE_COPY_REQUEST + 1);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.finish(request, false), this.timeout);
      this.pending.set(request, { session, resolve, reject, timer });
      try {
        if (!this.post({ kind: 'copy-code', session, revision, request, text })) this.finish(request, false);
      } catch {
        this.finish(request, false);
      }
    });
  }

  receive(data: unknown): void {
    const parsed = codeCopyResultSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    const pending = this.pending.get(message.request);
    if (!pending || pending.session !== message.session || this.context().session !== message.session) return;
    this.finish(message.request, message.ok);
  }

  private finish(request: number, ok: boolean): void {
    const pending = this.pending.get(request);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(request);
    if (ok) pending.resolve();
    else pending.reject(new Error('Code could not be copied.'));
  }
}
