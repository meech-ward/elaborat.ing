/** Start independent preview work in source order without a slow item blocking
 * later ready results. Each task owns its error placeholder; cancellation stops
 * queued work and callers discard already-running results with the signal. */
export async function prepareVisibleAssets<T>(items: readonly T[], signal: AbortSignal, prepare: (item: T) => Promise<void>, concurrency = 3): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < items.length) {
      const item = items[next++];
      try { await prepare(item); }
      catch { /* A failed asset leaves only its own placeholder. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
