import { useCallback, useRef, useState, type RefObject } from "react";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import { planDelete, type DeletePlan, type DeleteRequest } from "./deletePlan";
import { openFilesProblem } from "./moveSessions";
import type { OperationSession } from "./operationSession";
import type { OpenTab } from "./tabs";
import { projectFiles } from "./useFileMoves";
import type { WorkspaceStore } from "./workspaceStore";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the files looked like when the confirmation opened; a delete saves only if nothing it lists has changed. */
const planKey = (plan: DeletePlan) => JSON.stringify([plan.files, plan.folders, plan.references, plan.blockers, plan.changes]);

/** One line for the notice after a delete. */
function summary(request: DeleteRequest, done: DeletePlan): string {
  const count = done.files.length;
  if ("folder" in request) {
    return `Deleted ${request.folder}${count ? ` with the ${count} ${count === 1 ? "file" : "files"} in it` : ""}.`;
  }
  const generated = count - 1;
  return `Deleted ${request.path}${generated ? ` with its ${generated} generated ${generated === 1 ? "file" : "files"}` : ""}.`;
}

class StalePlanError extends Error {
  constructor(readonly plan: DeletePlan) {
    super("Files changed since the confirmation opened. Check what goes now, then delete again.");
  }
}

/**
 * Deletes of files and folders. What goes is planned from the files on this
 * device when the confirmation opens, and planned again when the person
 * confirms; if that changed, the new plan is shown instead. The delete is
 * saved on this device as one change, which sync sends to the server as one
 * save, and the tabs of deleted files close.
 */
export function useFileDeletes({ client, tabs, sessions, notify, onDeleted }: {
  client: WorkspaceStore;
  tabs: RefObject<OpenTab[]>;
  sessions: RefObject<Map<string, OperationSession>>;
  notify: (message: string) => void;
  /** Called with the deleted files once the delete is saved, to close their tabs. */
  onDeleted: (paths: string[]) => void;
}) {
  const [request, setRequest] = useState<DeleteRequest | null>(null);
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [pending, setPending] = useState(false);
  /** The delete itself is saving; until then the confirmation can be cancelled. */
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const busy = useRef(false);
  const sequence = useRef(0);

  const planFor = useCallback(async (next: DeleteRequest) => {
    // An open editor's last draft write lands first, so the plan sees its unsaved edits.
    await client.flushLocalDrafts();
    const { files, folders, explicit } = await projectFiles(client);
    return planDelete(files, folders, explicit, next);
  }, [client]);
  // The plan's own blockers already say what to do; the open tabs are checked when there are none.
  const sessionProblem = (next: DeletePlan) => (next.blockers.length ? null : openFilesProblem(next.files, tabs.current, sessions.current));

  const openFor = async (next: DeleteRequest) => {
    if (busy.current) return;
    const current = ++sequence.current;
    setRequest(next);
    setPlan(null);
    setError(null);
    setStale(false);
    setPending(true);
    try {
      const planned = await planFor(next);
      if (current !== sequence.current) return;
      setPlan(planned);
      setError(sessionProblem(planned));
    } catch (cause) {
      if (current === sequence.current) setError(message(cause));
    } finally {
      if (current === sequence.current) setPending(false);
    }
  };

  const commit = async () => {
    if (!request || !plan || busy.current || plan.blockers.length) return;
    busy.current = true;
    setPending(true);
    setDeleting(true);
    setError(null);
    setStale(false);
    try {
      const current = await planFor(request);
      if (planKey(current) !== planKey(plan)) throw new StalePlanError(current);
      const blocker = current.blockers[0];
      if (blocker) throw new Error(`${blocker.path}: ${blocker.reason}`);
      const problem = openFilesProblem(current.files, tabs.current, sessions.current);
      if (problem) throw new Error(problem);
      for (const path of current.files) sessions.current.get(path)?.freeze();
      try {
        await client.save(current.changes);
      } catch (cause) {
        if (cause instanceof LocalConflictError) throw new Error(`${cause.path} changed just now, so nothing was deleted. Try again.`);
        throw cause;
      } finally {
        for (const path of current.files) sessions.current.get(path)?.release();
      }
      onDeleted(current.files);
      ++sequence.current;
      setRequest(null);
      setPlan(null);
      notify(summary(request, current));
    } catch (cause) {
      if (cause instanceof StalePlanError) {
        setPlan(cause.plan);
        setStale(true);
        setError(sessionProblem(cause.plan));
      } else {
        setError(message(cause));
      }
    } finally {
      busy.current = false;
      setPending(false);
      setDeleting(false);
    }
  };

  return {
    request, plan, pending, deleting, error, stale,
    commit: () => void commit(),
    deleteFile: (path: string) => void openFor({ path }),
    deleteFolder: (folder: string) => void openFor({ folder }),
    close: () => {
      if (busy.current) return;
      ++sequence.current;
      setRequest(null);
      setPlan(null);
      setPending(false);
    },
  };
}
