/**
 * The page's side of a D2 engine in a worker (d2EngineServe.ts): it starts
 * the engine with `init`, sends each compile under an id and answers it
 * when its reply comes, in any order, and fails every compile once the
 * worker stops or its file does not load. The app's engine (d2Engine.ts)
 * and the chat card's (src/chat-card/diagram/d2Engine.ts) each start their
 * worker their own way.
 */
import type { D2CompileRequest } from './compiler.ts';
import type { D2EngineReply, D2EngineRequest } from './d2EngineServe.ts';
import type { D2Diagram } from './types.ts';

type Pending = { resolve: (data: { diagram: D2Diagram }) => void; reject: (error: Error) => void };

export class D2EngineClient<Init extends object> {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped: Error | null = null;

  constructor(
    readonly worker: Worker,
    init: Init,
  ) {
    this.worker.onmessage = ({ data }: MessageEvent<D2EngineReply>) => {
      const request = this.pending.get(data.id);
      this.pending.delete(data.id);
      if ('error' in data) request?.reject(new Error(data.error));
      else request?.resolve(data.data as { diagram: D2Diagram });
    };
    // The worker's own file did not load, or it stopped.
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.stopped = new Error(event.message || 'The diagram engine stopped.');
      for (const request of this.pending.values()) request.reject(this.stopped);
      this.pending.clear();
    };
    this.post({ type: 'init', ...init });
  }

  compile(request: D2CompileRequest): Promise<{ diagram: D2Diagram }> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'compile', id, request });
    });
  }

  private post(message: D2EngineRequest<Init>): void {
    this.worker.postMessage(message);
  }
}
