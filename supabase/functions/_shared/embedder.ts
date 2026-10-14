/** The Edge Runtime's model session, as the functions here use it. */
export interface ModelSession {
  run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown>
}

/**
 * Embeds text with a model session made on first use, not when the worker
 * boots. Making a session starts loading the model, and a load that fails
 * while nothing awaits it stops the worker together with the request it is
 * serving, even one that never embeds anything. Here the first run awaits
 * the load, so a failure reaches only that caller. A run that fails drops
 * its session, so the next call loads the model again.
 */
export function lazyEmbedder(createSession: () => ModelSession): (text: string) => Promise<number[]> {
  let session: ModelSession | undefined
  return async (text) => {
    const current = (session ??= createSession())
    try {
      return (await current.run(text, { mean_pool: true, normalize: true })) as number[]
    } catch (error) {
      if (session === current) session = undefined
      throw error
    }
  }
}
