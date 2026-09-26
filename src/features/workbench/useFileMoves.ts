import { useCallback, useRef, useState, type Dispatch, type RefObject } from "react";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import { holdsReferences, planMove, type MovePlan, type MoveRequest, type MoveSourceFile } from "./movePlan";
import { affectedMovePaths, moveSessionProblem } from "./moveSessions";
import type { OperationSession } from "./operationSession";
import type { OpenTab, TabAction } from "./tabs";
import type { WorkspaceStore } from "./workspaceStore";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the files looked like when the plan was made; a move saves only if nothing it touches has changed. */
const planKey = (plan: MovePlan) => JSON.stringify([plan.moves, plan.updates, plan.blockers, plan.changes]);

/** Every file with the contents the planner needs, read from this device. */
async function projectFiles(client: WorkspaceStore): Promise<{ files: MoveSourceFile[]; folders: string[] }> {
  const { files, directories } = await client.listEntries();
  const loaded = await Promise.all(
    files.map(async (ref): Promise<MoveSourceFile> => {
      if (!holdsReferences(ref.path)) {
        return { path: ref.path, revision: ref.revision ?? "", saved: null, draft: ref.draft ? "" : null, conflict: ref.conflict };
      }
      const file = await client.read(ref.path);
      return { path: file.path, revision: file.revision ?? "", saved: file.savedContent, draft: file.draft ? file.content : null, conflict: file.conflict };
    }),
  );
  return { files: loaded, folders: directories };
}

/** One line for the notice after a rename or move. */
function summary(verb: string, done: MovePlan): string {
  const count = done.updates.filter(update => !done.moves.some(entry => entry.from === update.path)).length;
  const also = done.moves.length > 1 ? ` with its ${done.moves.length - 1} generated ${done.moves.length === 2 ? "file" : "files"}` : "";
  const references = count ? ` Updated references in ${count} ${count === 1 ? "file" : "files"}.` : "";
  return `${verb} ${done.moves[0].from} to ${done.moves[0].to}${also}.${references}`;
}

class StalePlanError extends Error {
  constructor(readonly plan: MovePlan) {
    super("Files changed since the preview. Check the new preview, then move again.");
  }
}

/**
 * Renames and moves. A move is planned from the files on this device, then
 * saved there as one change (the moves and every rewritten reference), which
 * sync sends to the server as one save. Open tabs follow their files.
 */
export function useFileMoves({ client, tabs, sessions, dispatch, notify }: {
  client: WorkspaceStore;
  tabs: RefObject<OpenTab[]>;
  sessions: RefObject<Map<string, OperationSession>>;
  dispatch: Dispatch<TabAction>;
  notify: (message: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const busy = useRef(false);
  const request = useRef(0);

  const planFor = useCallback(async (move: MoveRequest) => {
    const { files, folders } = await projectFiles(client);
    return planMove(files, folders, move);
  }, [client]);

  /** Plan again from the files as they are now, and save it if it matches what the person saw. */
  const apply = useCallback(async (move: MoveRequest, previewed: MovePlan | null): Promise<MovePlan> => {
    const current = await planFor(move);
    if (previewed && planKey(previewed) !== planKey(current)) throw new StalePlanError(current);
    const blocker = current.blockers[0];
    if (blocker) throw new Error(`${blocker.path}: ${blocker.reason}`);
    const problem = moveSessionProblem(current, tabs.current, sessions.current);
    if (problem) throw new Error(problem);
    const paths = affectedMovePaths(current);
    for (const path of paths) sessions.current.get(path)?.freeze();
    try {
      try {
        await client.save(current.changes);
      } catch (cause) {
        if (cause instanceof LocalConflictError) throw new Error(`${cause.path} changed just now, so nothing was moved. Try again.`);
        throw cause;
      }
      const moved = new Map(current.moves.map(entry => [entry.from, entry.to]));
      const updated = new Set(current.updates.map(update => update.path));
      const open = tabs.current.filter(tab => moved.has(tab.path) || updated.has(tab.path));
      const files = await Promise.all(open.map(async tab => {
        const path = moved.get(tab.path) ?? tab.path;
        const read = await client.read(path);
        return { from: tab.path, path, content: read.content, revision: read.revision };
      }));
      dispatch({ type: "move-reconciled", files });
    } finally {
      for (const path of paths) sessions.current.get(path)?.release();
    }
    return current;
  }, [client, dispatch, planFor, sessions, tabs]);

  const rename = useCallback(async (path: string, name: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      notify(summary("Renamed", await apply({ path, name }, null)));
    } catch (cause) {
      notify(`Rename refused: ${message(cause)}`);
    } finally {
      busy.current = false;
    }
  }, [apply, notify]);

  const preview = async () => {
    if (!target || busy.current) return;
    const sequence = ++request.current;
    setPending(true);
    setError(null);
    setStale(false);
    setPlan(null);
    try {
      const next = await planFor({ path: target, folder });
      if (sequence !== request.current) return;
      setPlan(next);
      // The plan's own blockers already say what to do; the open tabs are checked when there are none.
      setError(next.blockers.length ? null : moveSessionProblem(next, tabs.current, sessions.current));
    } catch (cause) {
      if (sequence === request.current) setError(message(cause));
    } finally {
      if (sequence === request.current) setPending(false);
    }
  };

  const commit = async () => {
    if (!target || !plan || busy.current || plan.blockers.length) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const done = await apply({ path: target, folder }, plan);
      setTarget(null);
      setPlan(null);
      notify(summary("Moved", done));
    } catch (cause) {
      if (cause instanceof StalePlanError) {
        setPlan(cause.plan);
        setStale(true);
        setError(cause.plan.blockers.length ? null : moveSessionProblem(cause.plan, tabs.current, sessions.current));
      } else {
        setError(message(cause));
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return {
    target, folder, plan, pending, error, stale, rename, preview, commit,
    open: (path: string) => {
      if (busy.current) return;
      ++request.current;
      setTarget(path);
      setFolder("");
      setPlan(null);
      setError(null);
      setStale(false);
    },
    changeFolder: (path: string) => {
      ++request.current;
      setFolder(path);
      setPlan(null);
      setError(null);
      setStale(false);
    },
    close: () => {
      if (busy.current) return;
      ++request.current;
      setTarget(null);
      setPlan(null);
      setPending(false);
    },
  };
}
