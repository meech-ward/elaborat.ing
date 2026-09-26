import type { MovePlan } from "./movePlan";
import type { OperationSession } from "./operationSession";
import type { OpenTab } from "./tabs";

/** Every path a move touches: where files leave, where they arrive, and files whose references change. */
export function affectedMovePaths(plan: Pick<MovePlan, "moves" | "updates">): string[] {
  return [...new Set([...plan.moves.flatMap(move => [move.from, move.to]), ...plan.updates.map(update => update.path)])];
}

/**
 * Why the open editors stop a move right now, or null. An open file the move
 * touches must match its saved copy, with no edit or save in flight, and no
 * tab may already be open where a file will arrive.
 */
export function moveSessionProblem(
  plan: Pick<MovePlan, "moves" | "updates">,
  tabs: readonly OpenTab[],
  sessions: ReadonlyMap<string, OperationSession>,
): string | null {
  for (const move of plan.moves) {
    if (tabs.some(tab => tab.path === move.to)) return `${move.to} is already open. Close that tab first.`;
  }
  const affected = new Set(affectedMovePaths(plan));
  for (const tab of tabs) {
    if (!affected.has(tab.path)) continue;
    const state = sessions.get(tab.path)?.state();
    if (tab.dirty || state?.dirty) return `${tab.path} has unsaved changes. Save or discard them first.`;
    if (!state || !state.reconciled) return `${tab.path} is not up to date with its saved copy. Wait a moment, then try again.`;
    if (state.saving) return `${tab.path} is saving. Wait for the save to finish.`;
    if (state.pending) return `${tab.path} has an edit in progress. Wait for it to finish.`;
  }
  return null;
}
