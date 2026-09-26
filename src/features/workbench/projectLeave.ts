import type { OperationSession } from './operationSession';

export type PrepareProjectLeave = () => Promise<() => void>;

/** Freeze live sessions, make shared drafts durable, and release on any refusal. */
export async function prepareProjectLeave(
  sessions: ReadonlyMap<string, OperationSession>,
  durableDrafts: boolean,
  flush: () => Promise<void>,
  externalProblem: () => string | null = () => null,
): Promise<() => void> {
  // Another operation owns its locks. Never freeze or release those sessions.
  const problem = externalProblem();
  if (problem) throw new Error(problem);
  const entries = [...sessions];
  let released = false;
  const release = () => { if (released) return; released = true; for (const [, session] of entries) session.release(); };
  const check = () => {
    for (const [path, session] of entries) {
      const state = session.state();
      if (state.saving || state.pending) throw new Error(`${path} has an edit or operation in progress. Wait for it to finish before leaving.`);
      if (!state.reconciled) throw new Error(`${path} is not reconciled. Save or reload it before leaving.`);
      if (state.dirty && !durableDrafts) throw new Error(`${path} has unsaved changes. Save them, or close that tab and confirm discard, before leaving.`);
      if (durableDrafts && !session.persistDraft) throw new Error(`${path} cannot confirm its local draft. Save or retry before leaving.`);
    }
  };
  try {
    for (const [, session] of entries) session.freeze();
    check();
    if (durableDrafts) for (const [, session] of entries) await session.persistDraft!();
    await flush();
    check();
    return release;
  } catch (error) { release(); throw error; }
}
