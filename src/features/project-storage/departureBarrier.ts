/** Online recovery waits for a user-owned departure instead of losing its event. */
export class DepartureBarrier {
  private current: Promise<void> | null = null;
  private reconnecting: Promise<void> | null = null;

  begin(): () => void {
    if (this.current) throw new Error('A project transition is already in progress.');
    let resolve!: () => void;
    const current = new Promise<void>(done => { resolve = done; });
    this.current = current;
    return () => {
      if (this.current !== current) return;
      this.current = null;
      resolve();
    };
  }

  async wait(): Promise<void> {
    while (this.current) await this.current;
  }

  reconnect(work: () => Promise<void>): Promise<void> {
    if (!this.reconnecting) this.reconnecting = (async () => { await this.wait(); await work(); })().finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }
}

/** Coalesce repeated browser online events, retaining the first until departure settles. */
export function reconnectAfterDeparture(barrier: DepartureBarrier, reconnect: () => Promise<void>): () => Promise<void> {
  return () => barrier.reconnect(reconnect);
}
