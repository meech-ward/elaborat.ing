import { useCallback, useRef, useState, type Dispatch, type RefObject } from "react";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import { holdsReferences, planFolderMove, planMove, type FolderMoveRequest, type MovePlan, type MoveRequest, type MoveSourceFile } from "./movePlan";
import { affectedMovePaths, moveSessionProblem } from "./moveSessions";
import type { OperationSession } from "./operationSession";
import type { OpenTab, TabAction } from "./tabs";
import type { WorkspaceStore } from "./workspaceStore";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the files looked like when the plan was made; a move saves only if nothing it touches has changed. */
const planKey = (plan: MovePlan) => JSON.stringify([plan.moves, plan.updates, plan.blockers, plan.changes]);

/** Every file with the contents the planner needs, and every folder (`explicit`: the stored ones), read from this device. */
async function projectFiles(client: WorkspaceStore): Promise<{ files: MoveSourceFile[]; folders: string[]; explicit: string[] }> {
  const { files, directories, folders } = await client.listEntries();
  const loaded = await Promise.all(
    files.map(async (ref): Promise<MoveSourceFile> => {
      if (!holdsReferences(ref.path)) {
        return { path: ref.path, revision: ref.revision ?? "", saved: null, draft: ref.draft ? "" : null, conflict: ref.conflict };
      }
      const file = await client.read(ref.path);
      return { path: file.path, revision: file.revision ?? "", saved: file.savedContent, draft: file.draft ? file.content : null, conflict: file.conflict };
    }),
  );
  return { files: loaded, folders: directories, explicit: folders };
}

/** One line for the notice after a rename or move. */
function summary(verb: string, done: MovePlan): string {
  const count = done.updates.filter(update => !done.moves.some(entry => entry.from === update.path)).length;
  const references = count ? ` Updated references in ${count} ${count === 1 ? "file" : "files"}.` : "";
  if (done.folder) {
    const files = done.moves.length ? ` with the ${done.moves.length} ${done.moves.length === 1 ? "file" : "files"} in it` : "";
    return `${verb} ${done.folder.from} to ${done.folder.to}${files}.${references}`;
  }
  const also = done.moves.length > 1 ? ` with its ${done.moves.length - 1} generated ${done.moves.length === 2 ? "file" : "files"}` : "";
  return `${verb} ${done.moves[0].from} to ${done.moves[0].to}${also}.${references}`;
}

class StalePlanError extends Error {
  constructor(readonly plan: MovePlan) {
    super("Files changed since the preview. Check the new preview, then move again.");
  }
}

/**
 * Renames and moves of files and folders. A move is planned from the files
 * on this device, then saved there as one change (the moves, every rewritten
 * reference, and a folder's explicit folders), which sync sends to the
 * server as one save. Open tabs follow their files.
 */
export function useFileMoves({ client, tabs, sessions, dispatch, notify, onFolderMove }: {
  client: WorkspaceStore;
  tabs: RefObject<OpenTab[]>;
  sessions: RefObject<Map<string, OperationSession>>;
  dispatch: Dispatch<TabAction>;
  notify: (message: string) => void;
  /** Called just before a folder move is saved, so the explorer's folder state can go with it. */
  onFolderMove?: (from: string, to: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  /** Whether `target` is a file or a folder. */
  const [kind, setKind] = useState<"file" | "folder">("file");
  const [folder, setFolder] = useState("");
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const busy = useRef(false);
  const request = useRef(0);

  const planFor = useCallback(async (move: MoveRequest | FolderMoveRequest) => {
    const { files, folders, explicit } = await projectFiles(client);
    return "path" in move ? planMove(files, folders, move) : planFolderMove(files, folders, explicit, move);
  }, [client]);

  /** Plan again from the files as they are now, and save it if it matches what the person saw. */
  const apply = useCallback(async (move: MoveRequest | FolderMoveRequest, previewed: MovePlan | null): Promise<MovePlan> => {
    const current = await planFor(move);
    if (previewed && planKey(previewed) !== planKey(current)) throw new StalePlanError(current);
    const blocker = current.blockers[0];
    if (blocker) throw new Error(`${blocker.path}: ${blocker.reason}`);
    const problem = moveSessionProblem(current, tabs.current, sessions.current);
    if (problem) throw new Error(problem);
    const paths = affectedMovePaths(current);
    for (const path of paths) sessions.current.get(path)?.freeze();
    try {
      if (current.folder) onFolderMove?.(current.folder.from, current.folder.to);
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
  }, [client, dispatch, onFolderMove, planFor, sessions, tabs]);

  const renameWith = useCallback(async (move: MoveRequest | FolderMoveRequest) => {
    if (busy.current) return;
    busy.current = true;
    try {
      notify(summary("Renamed", await apply(move, null)));
    } catch (cause) {
      notify(`Rename refused: ${message(cause)}`);
    } finally {
      busy.current = false;
    }
  }, [apply, notify]);
  const rename = useCallback((path: string, name: string) => renameWith({ path, name }), [renameWith]);
  const renameFolder = useCallback((folder: string, name: string) => renameWith({ folder, name }), [renameWith]);
  const requestFor = (destination: string): MoveRequest | FolderMoveRequest | null =>
    target === null ? null : kind === "folder" ? { folder: target, into: destination } : { path: target, folder: destination };

  const preview = async () => {
    const move = requestFor(folder);
    if (!move || busy.current) return;
    const sequence = ++request.current;
    setPending(true);
    setError(null);
    setStale(false);
    setPlan(null);
    try {
      const next = await planFor(move);
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
    const move = requestFor(folder);
    if (!move || !plan || busy.current || plan.blockers.length) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const done = await apply(move, plan);
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

  const openFor = (path: string, what: "file" | "folder") => {
    if (busy.current) return;
    ++request.current;
    setTarget(path);
    setKind(what);
    setFolder("");
    setPlan(null);
    setError(null);
    setStale(false);
  };

  return {
    target, kind, folder, plan, pending, error, stale, rename, renameFolder, preview, commit,
    open: (path: string) => openFor(path, "file"),
    openFolder: (path: string) => openFor(path, "folder"),
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
