import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useTabReorder } from "./useTabReorder";
import { TabStrip } from "./TabStrip";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  ChevronLeft,
  Diamond,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
import { Banner, BannerAction, FloatingPanel, PanelMessage, QuickOpen, confirmAction, type ActionMenuProps, type MenuEntry, type PanelRowSize, type QuickOpenCommand, type QuickOpenMode } from "@/features/design-system";
import { DottedPage } from "@/components/panel";
import { useOpenSettings } from "@/features/settings/SettingsDialog";
import { embedded } from "@/features/embed/mode";
import { Link, useNavigate } from "@tanstack/react-router";
import { accountName, personName, signOut, useAuth } from "@/features/auth";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import { companionPaths, isValidProjectPath } from "@/features/project-storage/model";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { parseDrawingFile } from "@/features/drawings/parse";
import { readChosenFile } from "@/lib/fileAdapter";
import { kindForPath } from "./session";
import { WorkspaceSession } from "./WorkspaceSession";
import { TablineProvider } from "./tabline";
import { EditorHeader, EmptyState, IconButton, PhoneHeader, RoundIconButton, commandShortcut, commentsShortcut, isApplePlatform } from "@/features/design-system";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { useCompactWorkbench } from "./compactWorkbench";
import { ExplorerTree } from "./ExplorerTree";
import { FileSearch } from "./FileSearch";
import { AccountPanel, FilesPanel, NewButtons, ProjectPanel, TreeScroller, type PanelPerson, type PanelSync } from "./SidePanels";
import { SignUpTo } from "@/features/projects/LocalProject";
import type { FileSearchHit } from "./contentSearch";
import { useConnectedAgentCount } from "@/features/agents/useConnectedAgentCount";
import { CommentsGuestProvider, CommentsSurface, CommentsToggle, useCommentsUi, useProjectComments } from "@/features/comments";
import { AgentChangesEntry, AgentChangesSurface } from "@/features/agent-changes";
import { NewEntryField } from "./NewEntryField";
import { duplicatePath, nameStemLength, newEntryNoun, newFilePath, newFolderError, proposedName, type NewEntryKind } from "./newEntries";
import { nativePathFor, readDiagramCompanion } from "./diagramFiles";
import { RenameDialog } from "./RenameDialog";
import { prepareProjectLeave, type PrepareProjectLeave } from "./projectLeave";
import type { OperationSession } from "./operationSession";
import type { WorkspaceFileRef, WorkspaceStore } from "./workspaceStore";
import {
  ancestorsOf,
  buildFolderTree,
  hideGeneratedFiles,
  joinFolder,
  revealAncestors,
} from "./folderTree";
import {
  MAX_EXPANDED_FOLDERS,
  defaultFolderPreferences,
  followFolderMove,
  pruneFolderPreferences,
  readFolderPreferences,
  writeFolderPreferences,
  type FolderPreferences,
} from "./folderPreferences";
import { type TabFile } from "./tabs";
import { LazyMoveDialog } from "./LazyMoveDialog";
import { DeleteDialog } from "./DeleteDialog";
import { LazyDiagramView as DiagramView, LazyDrawingView as DrawingView } from "./LazyCanvasViews";
import { FLOW_D2_EXAMPLE } from "@/features/structured/examples";
import { useFileMoves } from "./useFileMoves";
import { useFileDeletes } from "./useFileDeletes";
import { emptyNavigationTabs, navigationTabTransition } from "./navigationTabs";
import { useFileLocation } from "../navigation/useFileLocation";
import {
  isMissingFileError,
  readPersistedTabs,
  retainUnrestoredTabs,
  toPersistedTabs,
  writePersistedTabs,
  type PersistedTabs,
} from "./tabPersistence";
import "./workbench.css";

/**
 * The editor for one project: an explorer, tabs of open files, each a
 * source and rendered editor, saves to this device (sync sends them), and a
 * command palette. On a desktop it sits in floating panels on a dotted
 * background: the project (its menu, share and notices), the files and the
 * account with the sync state (`sync`) down the side (SidePanels), and
 * the editor. On a phone the same panels are a files screen of their own,
 * and an open file fills the screen with a floating Back button that
 * returns to it.
 */
export function WorkspaceWorkbench({
  client,
  onLeaveGuard,
  projectId,
  projectName = "Project",
  projectMenu = [],
  onShare,
  projectNotices,
  sync = null,
  onSyncNow,
  searchFiles = null,
  onResolveConflict,
  readOnly = null,
  local = false,
}: {
  client: WorkspaceStore;
  onLeaveGuard?: (guard: PrepareProjectLeave | null) => void;
  projectId: string;
  /** The project's name, at the top of the side panels. */
  projectName?: string;
  /** The other projects and the way home: the start of the project menu, before its actions. */
  projectMenu?: readonly MenuEntry[];
  /** Opens sharing; without it (a viewer, or offline) there is no share button. */
  onShare?: () => void;
  /** What the project needs to say (read-only, errors), under the project panel. */
  projectNotices?: ReactNode;
  /** The sync state, shown with the person. */
  sync?: PanelSync | null;
  /** Sync now, in the person's menu. */
  onSyncNow?: () => void;
  /** Finds this project's files by their text (the files panel's search); null when offline or signed out. */
  searchFiles?: ((query: string) => Promise<FileSearchHit[]>) | null;
  onResolveConflict?: (path: string, choice: ConflictChoice) => Promise<void>;
  /**
   * Why the project cannot be changed (the person is a viewer, or it is
   * archived), or null. Files are then shown read-only, and nothing offers to
   * create, import, rename, move or delete them; the project header says why.
   */
  readOnly?: string | null;
  /** The local project of someone without an account: what needs one is shown locked, linking to sign-up. */
  local?: boolean;
}) {
  const { href, target, navigate } = useFileLocation();
  const locationRef = useRef({ href, target, navigate });
  useLayoutEffect(() => { locationRef.current = { href, target, navigate }; }, [href, target, navigate]);
  const [initialTarget] = useState(target);
  const [locationProblem, setLocationProblem] = useState<{ href: string; message: string } | null>(null);
  const [retryLocation, setRetryLocation] = useState(0);
  const leaveSessions = useRef(new Map<string, OperationSession>());
  const savedSessions = useRef(new Set<string>());
  const preferenceStorage = useMemo(() => ({
    getItem: (key: string) => window.localStorage.getItem(`${client.persistenceKey}:${key}`),
    setItem: (key: string, value: string) => window.localStorage.setItem(`${client.persistenceKey}:${key}`, value),
  }), [client.persistenceKey]);
  const tabListId = useId();
  const tabId = (path: string) => `${tabListId}-${encodeURIComponent(path)}`;
  const [state, dispatch] = useReducer(navigationTabTransition, emptyNavigationTabs);
  // Latest committed tabs for async completions (rename): the callback
  // closure is stale by the time a request settles, and only current
  // dirty/presence state may gate a tab relabel. Synced in an effect so
  // the render body never mutates a ref.
  const tabsRef = useRef(state.tabs);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    tabsRef.current = state.tabs;
    stateRef.current = state;
  });
  const [files, setFiles] = useState<WorkspaceFileRef[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const narrow = useCompactWorkbench();
  // The side panels start open on a desktop; on a phone `sidebar` is the files
  // screen, which shows over the open file until a file is opened.
  const [sidebar, setSidebar] = useState(() => !narrow);
  const [panel, setPanel] = useState(false);
  // The comments of the file on screen (from the project page), and their
  // panel; without an account the panel only links to sign-up.
  const comments = useProjectComments();
  const commentsUi = useCommentsUi();
  const [guestComments, setGuestComments] = useState(false);
  // Element that opened the command palette; Escape/focus return goes here.
  const paletteInvoker = useRef<HTMLElement | null>(null);
  // The project panel, whose menu button the palette returns focus to when the menu opened it.
  const projectPanel = useRef<HTMLElement>(null);
  const openPalette = (invoker: HTMLElement | null) => {
    paletteInvoker.current = invoker;
    setPaletteMode("commands");
    setPalette(true);
  };
  const explorerPanel = usePanelRef();
  const bottomPanel = usePanelRef();
  const [explorerWidth, setExplorerWidth] = useState(264);
  // Focus mode (desktop): only the file and its controls; not kept across reloads.
  const [focus, setFocus] = useState(false);
  // Where the active file's controls go in the editor's top line (desktop).
  const [tablineSlot, setTablineSlot] = useState<HTMLElement | null>(null);
  const [bottomHeight, setBottomHeight] = useState(190);
  const [palette, setPalette] = useState(false);
  // Cmd+P finds a file; Cmd+K (and the project menu's Command palette) runs a command.
  const [paletteMode, setPaletteMode] = useState<QuickOpenMode>("files");
  const [messages, setMessages] = useState<Record<string, string | null>>({});
  const openSettings = useOpenSettings();
  const auth = useAuth();
  const routerNavigate = useNavigate();
  const sequence = useRef(0);
  const restoreDone = useRef(false);
  const interacted = useRef(false);
  const closedDuringRestore = useRef(new Set<string>());
  const unresolvedRestore = useRef<string[]>([]);
  const [stored] = useState<PersistedTabs | null>(() => {
    try {
      if (typeof window === "undefined") return null;
      return readPersistedTabs(preferenceStorage);
    } catch {
      return null;
    }
  });
  const [folderPrefs, setFolderPrefs] = useState<FolderPreferences>(() => {
    try {
      if (typeof window === "undefined") return defaultFolderPreferences();
      return readFolderPreferences(preferenceStorage);
    } catch {
      return defaultFolderPreferences();
    }
  });
  // A new file or folder being named: in the explorer, or in a dialog on a phone.
  const [creating, setCreating] = useState<{ kind: NewEntryKind; dir: string; initial: string; key: number } | null>(null);
  // A new key for each name field, so each one starts from its proposed name.
  const creatingKey = useRef(0);
  // Runs once the workbench menu or the palette has closed, such as a new
  // file's name field, which then keeps the focus they would give back.
  const afterClose = useRef<(() => void) | null>(null);
  const runAfterClose = () => {
    const run = afterClose.current;
    afterClose.current = null;
    run?.();
  };
  // The menu gives focus back after it finishes closing, so its own flag says not to.
  const keepMenuFocus = useRef(false);
  const afterMenu = (run: () => void) => {
    afterClose.current = run;
    keepMenuFocus.current = true;
  };
  // Last active file whose ancestors were revealed: reveal runs once per
  // actual file change, never reopening a folder the user just collapsed.
  const revealedFor = useRef<string | null>(null);
  const [listed, setListed] = useState(false);
  const [persistReady, setPersistReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const refreshList = useCallback(async () => {
    try {
      const entries = await client.listEntries();
      setFiles(entries.files);
      setDirectories(entries.directories);
      setListed(true);
      setListError(null);
      // Prune only after a SUCCESSFUL authoritative list: vanished
      // directories leave expansion/selection, while folders backing open
      // unsaved drafts and the explicit root selection are kept. A failed
      // list never prunes: it is an error with retry, not an empty tree.
      const keep = new Set(entries.directories);
      for (const file of entries.files)
        for (const ancestor of ancestorsOf(file.path)) keep.add(ancestor);
      for (const tab of tabsRef.current) {
        if (tab.revision !== null) continue;
        for (const ancestor of ancestorsOf(tab.path)) keep.add(ancestor);
      }
      setFolderPrefs((prev) => pruneFolderPreferences(prev, [...keep]));
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setListError(message);
      setNotice(`File list failed: ${message}`);
      return null;
    }
  }, [client]);
  // Saves on this device and changes sync brings in both refresh the list.
  useEffect(() => client.subscribe(() => void refreshList()), [client, refreshList]);
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      writeFolderPreferences(preferenceStorage, folderPrefs);
    } catch {
      // Storage unavailable: keep in-memory state.
    }
  }, [folderPrefs, preferenceStorage]);
  // Reveal the active file's ancestors once per actual file change
  // (opening, tab switch, or restore), without disturbing folders the
  // user collapsed afterward and without changing the active editor.
  useEffect(() => {
    const activePath = state.active;
    if (!activePath || revealedFor.current === activePath) return;
    revealedFor.current = activePath;
    setFolderPrefs((prev) => {
      if (
        ancestorsOf(activePath).every((ancestor) =>
          prev.expanded.includes(ancestor),
        )
      )
        return prev;
      return {
        ...prev,
        expanded: revealAncestors(prev.expanded, activePath),
      };
    });
  }, [state.active]);
  const toggleFolder = useCallback((path: string) => {
    setFolderPrefs((prev) => ({
      ...prev,
      expanded: prev.expanded.includes(path)
        ? prev.expanded.filter((entry) => entry !== path)
        : [...prev.expanded, path].slice(-MAX_EXPANDED_FOLDERS),
    }));
  }, []);
  // null: new files and folders go at the top of the project.
  const selectFolder = useCallback((path: string | null) => {
    setFolderPrefs((prev) =>
      prev.selectedFolder === path ? prev : { ...prev, selectedFolder: path },
    );
  }, []);
  const refreshFiles = useCallback(async () => { await refreshList(); }, [refreshList]);
  // The folder's expanded state goes with it (see followFolderMove).
  const followFolder = useCallback((from: string, to: string) => {
    setFolderPrefs((prev) => followFolderMove(prev, from, to));
  }, []);
  const moves = useFileMoves({ client, tabs: tabsRef, sessions: leaveSessions, dispatch, notify: setNotice, onFolderMove: followFolder });
  // Tabs of deleted files close, as a close does; their edits were settled before the delete.
  const closeDeleted = useCallback((paths: string[]) => {
    const gone = new Set(paths);
    for (const path of paths) closedDuringRestore.current.add(path);
    const open = stateRef.current.tabs.filter((tab) => gone.has(tab.path));
    if (open.length === 0) return;
    interacted.current = true;
    if (stateRef.current.active !== null && gone.has(stateRef.current.active)) dispatch({ type: "request", sequence: ++sequence.current });
    for (const tab of open) dispatch({ type: "close", path: tab.path, discard: true });
    if (restoreDone.current) setPersistReady(true);
  }, []);
  const deletes = useFileDeletes({ client, tabs: tabsRef, sessions: leaveSessions, notify: setNotice, onDeleted: closeDeleted });
  const registerSession = useCallback((path: string, session: OperationSession | null) => {
    if (session) leaveSessions.current.set(path, session); else leaveSessions.current.delete(path);
    if (session?.state().reconciled) {
      savedSessions.current.add(path);
      const location = locationRef.current;
      if (stateRef.current.active === path && location.target.kind === "workspace" && location.target.projectId === projectId && location.target.path === null) {
        // A local picker/new note becomes linkable only once its live session
        // confirms a saved base. A same-named server list entry is insufficient.
        void location.navigate(projectId, path, true);
      }
    } else savedSessions.current.delete(path);
  }, [projectId]);
  // Drafts on this device are durable, so leaving keeps them rather than refusing.
  useLayoutEffect(() => {
    onLeaveGuard?.(() => prepareProjectLeave(leaveSessions.current, true, () => client.flushLocalDrafts()));
    return () => onLeaveGuard?.(null);
  }, [client, onLeaveGuard]);
  const openPath = useCallback(
    async (path: string, fromLocation = false): Promise<boolean> => {
      setLocationProblem(null);
      if (!fromLocation) interacted.current = true;
      const request = ++sequence.current;
      dispatch({ type: "request", sequence: request, fromLocation });
      if (stateRef.current.tabs.some((tab) => tab.path === path)) {
        if (fromLocation && !savedSessions.current.has(path) && !stateRef.current.tabs.find(tab => tab.path === path)?.revision) {
          setLocationProblem({ href: locationRef.current.href, message: `${path} is an unsaved local file. Save it before using a file link.` });
          return false;
        }
        dispatch({ type: "select", path, fromLocation });
        if (restoreDone.current && stateRef.current.active !== path)
          setPersistReady(true);
        return true;
      }
      setNotice(`Opening ${path}…`);
      try {
        const read = await client.read(path);
        if (sequence.current !== request) return false;
        if (fromLocation && read.savedContent === null) throw new Error("This file exists only as an unsaved local draft. Save it before using a file link.");
        unresolvedRestore.current = unresolvedRestore.current.filter(
          rememberedPath => rememberedPath !== path,
        );
        dispatch({
          type: "opened",
          sequence: request,
          fromLocation,
          file: { path, content: read.content, revision: read.revision, savedContent: read.savedContent },
        });
        if (sequence.current === request) setNotice(null);
        if (restoreDone.current) setPersistReady(true);
        return true;
      } catch (error) {
        if (sequence.current === request) {
          setNotice(
            `Open failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (fromLocation) setLocationProblem({ href: locationRef.current.href, message: `Cannot open ${path}: ${error instanceof Error ? error.message : String(error)}` });
        }
        return false;
      }
    },
    [client],
  );
  // Consume location changes once. Every new target invalidates outstanding reads,
  // including invalid links and a move back to a workspace with no file target.
  useLayoutEffect(() => {
    ++sequence.current;
    dispatch({ type: "request", sequence: sequence.current, fromLocation: true });
    if (target.kind === "workspace" && target.projectId === projectId && target.path) {
      // Synchronize the external router location with its file read/session.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void openPath(target.path, true);
    }
  }, [href, target, projectId, openPath, retryLocation]);
  useEffect(() => {
    const requests = sequence;
    return () => { ++requests.current; };
  }, []);

  const appliedCommand = useRef(0);
  useLayoutEffect(() => {
    const command = state.locationCommand;
    if (!command || command.version === appliedCommand.current) return;
    appliedCommand.current = command.version;
    const tab = state.tabs.find(tab => tab.path === command.path);
    const saved = tab && (savedSessions.current.has(tab.path) || Boolean(tab.revision) && tab.savedContent !== null);
    void navigate(projectId, saved ? tab.path : null, command.replace);
  }, [state.locationCommand, state.tabs, navigate, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await refreshList();
      if (cancelled) return;
      const defaultFile = entries?.files.find(file => file.path === "notes/notebook.mdx")
        ?? entries?.files.find(file => kindForPath(file.path) === "note");
      const paths = stored?.openPaths ?? (initialTarget.kind === "workspace" && initialTarget.path === null
        ? defaultFile ? [defaultFile.path] : [] : []);
      const results = await Promise.all(paths.map(async path => {
        try { const read = await client.read(path); return { ...read, path, ok: true as const }; }
        catch (error) { return { path, ok: false as const, error }; }
      }));
      if (cancelled) return;
      const successes: TabFile[] = [];
      const transient: string[] = [];
      for (const result of results) {
        if (closedDuringRestore.current.has(result.path)) continue;
        if (result.ok) successes.push(result);
        else if (isMissingFileError(result.error)) continue;
        else transient.push(result.path);
      }
      unresolvedRestore.current = transient;
      const current = locationRef.current.target;
      dispatch({ type: "restored", files: successes, order: stored?.openPaths, activePath: stored?.activePath ?? defaultFile?.path ?? null,
        activate: !interacted.current && current.kind === "workspace" && current.path === null });
      restoreDone.current = true;
      setPersistReady(true);
      // A remembered tab whose file is gone (deleted or renamed elsewhere, for
      // example by an agent) had nothing unsaved, since a draft would still
      // read: it just closes, without a warning.
      if (transient.length) setNotice(`Could not restore ${transient.length} tab(s) due to a temporary error; remembered tabs kept. Refresh to retry.`);
    })();
    return () => { cancelled = true; };
  }, [client, stored, initialTarget, refreshList]);
  useEffect(() => {
    if (!persistReady) return;
    try {
      writePersistedTabs(
        preferenceStorage,
        retainUnrestoredTabs(
          toPersistedTabs(
            state.tabs,
            state.active,
            state.tabs.map((tab) => tab.path),
          ),
          stored,
          unresolvedRestore.current,
        ),
      );
    } catch {
      // Storage unavailable: keep in-memory tabs.
    }
  }, [state.tabs, state.active, persistReady, stored, preferenceStorage]);
  const addDraft = useCallback((file: TabFile) => {
    interacted.current = true;
    const request = ++sequence.current;
    dispatch({ type: "request", sequence: request });
    dispatch({ type: "opened", sequence: request, file });
    if (narrow) setSidebar(false);
    if (restoreDone.current) setPersistReady(true);
  }, [narrow]);
  /** Names new files and folders must not take: every file, open unsaved tab and folder. */
  const takenNames = useCallback(
    () => ({ files: [...files.map((file) => file.path), ...stateRef.current.tabs.map((tab) => tab.path)], dirs: directories }),
    [directories, files],
  );
  /**
   * Ask for a new file or folder's name, in the selected folder (or the
   * root): an inline field in the explorer, which opens if it is hidden, or
   * a dialog on a phone.
   */
  const startCreate = useCallback(
    (kind: NewEntryKind) => {
      const selected = folderPrefs.selectedFolder ?? "";
      const dir = selected === "" || directories.includes(selected) ? selected : "";
      const taken = takenNames();
      setCreating({ kind, dir, initial: proposedName(kind, dir, [...taken.files, ...taken.dirs]), key: ++creatingKey.current });
      if (narrow) return;
      setSidebar(true);
      // Open the folder the field shows in.
      if (dir !== "") setFolderPrefs((prev) => ({ ...prev, expanded: revealAncestors(prev.expanded, joinFolder(dir, "untitled")) }));
    },
    [directories, folderPrefs.selectedFolder, narrow, takenNames],
  );
  /** Create what `creating` names, saved at once, and open a file in its tab. A refusal is thrown for the field to show. */
  const createEntry = useCallback(
    async (target: { kind: NewEntryKind; dir: string }, name: string) => {
      const taken = takenNames();
      if (target.kind === "folder") {
        const problem = newFolderError(target.dir, name, taken);
        if (problem) throw new Error(problem);
        const created = await client.createDirectory(joinFolder(target.dir, name));
        await refreshList();
        setFolderPrefs((prev) => ({
          selectedFolder: created.path,
          // Reveal the new folder itself by revealing a file inside it.
          expanded: revealAncestors(prev.expanded, joinFolder(created.path, "untitled")),
        }));
        setCreating(null);
        setNotice(`Created folder ${created.path}.`);
        return;
      }
      const checked = newFilePath(target.kind, target.dir, name, taken);
      if ("error" in checked) throw new Error(checked.error);
      // A drawing starts as an empty scene, a diagram as a small example
      // whose generated files appear on its first save, and a note empty.
      const content = target.kind === "drawing" ? '{"type":"excalidraw","version":2,"elements":[]}' : target.kind === "diagram" ? FLOW_D2_EXAMPLE : "";
      let saved;
      try {
        saved = await client.write(checked.path, { content, expectedRevision: null });
      } catch (cause) {
        if (cause instanceof LocalConflictError) throw new Error(`${checked.path} already exists. Choose another name.`);
        throw cause;
      }
      await refreshList();
      setCreating(null);
      addDraft({ path: checked.path, content, revision: saved.revision });
    },
    [addDraft, client, refreshList, takenNames],
  );
  const validateNew = (target: { kind: NewEntryKind; dir: string }) => (name: string) => {
    if (target.kind === "folder") return newFolderError(target.dir, name, takenNames());
    const checked = newFilePath(target.kind, target.dir, name, takenNames());
    return "error" in checked ? checked.error : null;
  };
  /**
   * Rename a new file that was never saved: its draft takes the new name,
   * with the latest text in its editor, and its tab follows. It is saved
   * under that name when it is saved.
   */
  const renameNewFile = useCallback(
    async (path: string, name: string) => {
      const slash = path.lastIndexOf("/");
      const to = slash === -1 ? name : `${path.slice(0, slash)}/${name}`;
      const session = leaveSessions.current.get(path);
      session?.freeze();
      try {
        await session?.persistDraft?.();
        await client.flushLocalDrafts();
        await client.renameDraft(path, to);
        const renamed = await client.read(to);
        dispatch({ type: "draft-renamed", from: path, to, content: renamed.content });
        await refreshList();
        setNotice(`Renamed ${path} to ${to}. It is not saved yet.`);
      } catch (error) {
        setNotice(`Rename refused: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        session?.release();
      }
    },
    [client, refreshList],
  );
  /**
   * Copy a file to "<name> copy" in its folder as it is on screen, unsaved
   * edits included, saved at once and opened in a new tab. The original is
   * not changed. A diagram's generated canvas and sidecar are copied with it,
   * so the copy keeps its layout and canvas edits.
   */
  const duplicateFile = useCallback(
    async (path: string) => {
      try {
        await leaveSessions.current.get(path)?.persistDraft?.();
        await client.flushLocalDrafts();
        const taken = takenNames();
        const to = duplicatePath(path, [...taken.files, ...taken.dirs]);
        const { content } = await client.read(path);
        const generated = kindForPath(path) === "diagram" ? companionPaths(path) : [];
        const copies = await Promise.all(generated.map(async (from, index) => ({ path: companionPaths(to)[index], file: await readDiagramCompanion(client, from) })));
        const saved = await client.save([
          { kind: "write", path: to, content, expectedRevision: null },
          ...copies.flatMap((copy) => (copy.file ? [{ kind: "write" as const, path: copy.path, content: copy.file.content, expectedRevision: null }] : [])),
        ]);
        await refreshList();
        addDraft({ path: to, content, revision: saved.find((file) => file.path === to)?.revision ?? saved[0].revision });
        setNotice(`Duplicated ${path} as ${to}.`);
      } catch (error) {
        setNotice(`Duplicate failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [addDraft, client, refreshList, takenNames],
  );
  const importFile = useCallback(
    async (file: File) => {
      try {
        const opened = await readChosenFile(file);
        if (!isValidProjectPath(opened.name))
          throw new Error("That file name cannot be used in a project.");
        if (state.tabs.some((tab) => tab.path === opened.name))
          throw new Error(
            "That file is already open. Close its tab before importing another copy.",
          );
        const kind = kindForPath(opened.name);
        if (kind === "drawing") parseDrawingFile(opened.text, opened.name);
        if (kind === "drawing" || kind === "diagram") {
          const saved = await client.write(opened.name, {
            content: opened.text,
            expectedRevision: null,
          });
          await refreshList();
          addDraft({
            path: opened.name,
            content: opened.text,
            revision: saved.revision,
          });
        } else
          addDraft({ path: opened.name, content: opened.text, revision: null });
      } catch (error) {
        setNotice(
          `Import failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [addDraft, client, refreshList, state.tabs],
  );
  const onState = useCallback(
    (path: string, dirty: boolean, message: string | null) => {
      dispatch({ type: "dirty", path, dirty });
      setMessages((prev) =>
        prev[path] === message ? prev : { ...prev, [path]: message },
      );
    },
    [],
  );
  const tabReorder = useTabReorder(state.tabs.map(tab => tab.path), drop => {
    interacted.current = true;
    dispatch({ type: "reorder", ...drop });
    if (restoreDone.current) setPersistReady(true);
  });
  const selectTab = (path: string) => {
    interacted.current = true;
    dispatch({ type: "request", sequence: ++sequence.current });
    dispatch({ type: "select", path });
    if (
      restoreDone.current &&
      state.active !== path &&
      state.tabs.some((tab) => tab.path === path)
    )
      setPersistReady(true);
  };
  const closeTab = async (path: string) => {
    const tab = state.tabs.find((tab) => tab.path === path);
    if (
      tab?.dirty &&
      !(await confirmAction(
        `Close ${path} and discard unsaved changes? Cancel to keep editing or save first.`,
        { confirmLabel: "Discard" },
      ))
    )
      return;
    void client.discardLocalDraft(path).then(() => {
      interacted.current = true;
      if (stateRef.current.active === path) dispatch({ type: "request", sequence: ++sequence.current });
      closedDuringRestore.current.add(path);
      dispatch({ type: "close", path, discard: true });
      if (restoreDone.current && tab) setPersistReady(true);
    }).catch((error: unknown) => setNotice(`Close stopped: ${String(error)}`));
  };
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "." && !narrow) {
        event.preventDefault();
        setFocus((v) => !v);
        return;
      }
      if (key === "b" || key === "j" || key === "`" || key === "k" || key === "p") {
        event.preventDefault();
        event.stopPropagation();
        if (key === "b") setSidebar((v) => !v);
        else if (key === "k" || key === "p") {
          // Opens that list; switches to it from the other one; closes it when it shows.
          const mode = key === "p" ? "files" : "commands";
          if (!palette && document.activeElement instanceof HTMLElement)
            paletteInvoker.current = document.activeElement;
          setPalette(!palette || paletteMode !== mode);
          setPaletteMode(mode);
        }
        else { setPanel((v) => !v); if (narrow) setSidebar(true); }
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [narrow, palette, paletteMode]);
  // ⌘D / Ctrl+D duplicates the active file, in place of the browser's
  // bookmark shortcut. The code editor and the canvases keep their own ⌘D
  // (select the next match, duplicate the selection), and text fields and
  // dialogs are left alone.
  useEffect(() => {
    if (readOnly) return;
    const apple = isApplePlatform();
    function key(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "d" || event.altKey || event.shiftKey) return;
      if (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      const path = stateRef.current.active;
      const target = event.target instanceof Element ? event.target : null;
      if (!path || target?.closest('.monaco-editor, .excalidraw, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      void duplicateFile(path);
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [duplicateFile, readOnly]);
  // Open unsaved tabs that are not server files appear in the visual
  // tree marked as drafts, without posing as saved files.
  const targetPath = target.kind === "workspace" && target.projectId === projectId ? target.path : null;
  const invalidLink = target.kind === "invalid" ? target.message
    : target.projectId !== projectId ? "That link is for another project." : null;
  const linkProblem = invalidLink ?? (locationProblem?.href === href ? locationProblem.message : null);
  const awaitingTarget = Boolean(targetPath && targetPath !== state.active);
  const hideSessions = Boolean(linkProblem || awaitingTarget);
  const navigationOutsideSession = hideSessions;
  // A drawing or a diagram on screen is the comments panel's file (a note's
  // session says so itself, as it also places the threads in its text).
  // A diagram's element comments hang on its generated canvas file.
  const commentsPath = !hideSessions && state.active && kindForPath(state.active) !== "note" && kindForPath(state.active) !== "text" ? state.active : null;
  const commentsServer = commentsPath ? (files.find((file) => file.path === commentsPath)?.server ?? null) : null;
  const commentsFileId = commentsServer?.id ?? null;
  const commentsVersion = commentsServer?.version ?? null;
  const canvasPath = commentsPath && kindForPath(commentsPath) === "diagram" ? nativePathFor(commentsPath) : null;
  const canvasServer = canvasPath ? (files.find((file) => file.path === canvasPath)?.server ?? null) : null;
  const canvasFileId = canvasServer?.id ?? null;
  const canvasVersion = canvasServer?.version ?? null;
  const commentsController = comments?.controller ?? null;
  useEffect(() => {
    if (!commentsController || !commentsPath) return;
    const file = commentsFileId !== null && commentsVersion !== null ? { path: commentsPath, fileId: commentsFileId, fileVersion: commentsVersion } : null;
    const elements = canvasPath === null ? undefined : canvasFileId !== null && canvasVersion !== null ? { path: canvasPath, fileId: canvasFileId, fileVersion: canvasVersion } : null;
    commentsController.show({ path: commentsPath, file, ...(elements === undefined ? {} : { elements }) });
    return () => commentsController.leave(commentsPath);
  }, [commentsController, commentsPath, commentsFileId, commentsVersion, canvasPath, canvasFileId, canvasVersion]);
  const openFromNavigation = async (path: string) => {
    if (await openPath(path)) { if (narrow) setSidebar(false); }
  };
  const serverPaths = new Set(files.map((file) => file.path));
  const draftPaths = state.tabs
    .filter((tab) => tab.revision === null && !serverPaths.has(tab.path))
    .map((tab) => tab.path);
  // A D2 diagram's generated canvas and layout files stay out of the tree.
  const tree = buildFolderTree(
    hideGeneratedFiles(files.map((file) => file.path)),
    directories,
    draftPaths,
  );
  // A file with no saved copy: renaming it only changes the name it will be saved under.
  const neverSaved = (path: string) => draftPaths.includes(path) || files.some((file) => file.path === path && file.revision === null);
  const treeIsEmpty =
    tree.folders.length === 0 && tree.rootFiles.length === 0;
  // The side panels' size: the desktop's, or the phone's larger rows (the
  // two never show at once).
  const panelSize: PanelRowSize = narrow ? "touch" : "default";
  // One explorer implementation for the desktop sidebar and the 390px
  // phone files screen: loading, error-with-retry, tree, and empty states.
  const explorerBody = (
    <>
      {!listed && !listError && <PanelMessage role="status" size={narrow ? "touch" : "default"} className="px-2 py-1.5">Loading files…</PanelMessage>}
      {listError && (
        <Banner tone="danger" className="mb-2" action={<BannerAction onClick={() => void refreshList()}>Retry</BannerAction>}>
          File list failed: {listError}
        </Banner>
      )}
      {(listed || !listError) && (
        <ExplorerTree
          tree={tree}
          size={panelSize}
          expanded={folderPrefs.expanded}
          selectedFolder={folderPrefs.selectedFolder}
          activeFile={state.active}
          isDirty={(path) =>
            state.tabs.some((tab) => tab.path === path && tab.dirty)
          }
          isUnsavedDraft={(path) =>
            state.tabs.some((tab) => tab.path === path && tab.revision === null)
          }
          onToggleFolder={toggleFolder}
          onSelectFolder={selectFolder}
          onOpenFile={(path) => {
            // Opening a file puts new files back at the top of the project.
            selectFolder(null);
            void openFromNavigation(path);
          }}
          onFeedback={setNotice}
          onRenameFile={readOnly ? undefined : (path, name) => (neverSaved(path) ? renameNewFile(path, name) : moves.rename(path, name))}
          isNeverSaved={neverSaved}
          onMoveFile={readOnly ? undefined : moves.open}
          onDuplicateFile={readOnly ? undefined : (path) => void duplicateFile(path)}
          onRenameFolder={readOnly ? undefined : moves.renameFolder}
          onMoveFolder={readOnly ? undefined : moves.openFolder}
          onDeleteFile={readOnly ? undefined : deletes.deleteFile}
          onDeleteFolder={readOnly ? undefined : deletes.deleteFolder}
          newEntry={creating && !narrow ? {
            dir: creating.dir,
            field: (
              <NewEntryField
                key={creating.key}
                kind={creating.kind}
                dir={creating.dir}
                initial={creating.initial}
                validate={validateNew(creating)}
                onCreate={(name) => createEntry(creating, name)}
                onCancel={() => setCreating(null)}
              />
            ),
          } : null}
        />
      )}
      {listed && !listError && treeIsEmpty && (
        <PanelMessage size={narrow ? "touch" : "default"} className="px-2 py-1.5">{readOnly ? "No files yet." : "No files yet. Create a note to start."}</PanelMessage>
      )}
    </>
  );
  // Cmd+K's commands, with the shortcuts that also run them. Files open from Cmd+P.
  const apple = isApplePlatform();
  const commands: QuickOpenCommand[] = [
    { label: "Toggle explorer", shortcut: commandShortcut("b", apple), run: () => setSidebar((v) => !v) },
    { label: "Toggle bottom panel", shortcut: commandShortcut("j", apple), run: () => setPanel((v) => !v) },
    ...((comments || local) && state.active
      ? [{ label: "Toggle comments", shortcut: commentsShortcut(apple), run: () => (comments ? comments.controller.setPanelOpen(!commentsUi.panelOpen) : setGuestComments((v) => !v)) }]
      : []),
    ...(embedded ? [] : [{ label: "Settings", run: () => { afterClose.current = openSettings; } }]),
    ...(narrow ? [] : [{ label: focus ? "Exit full screen" : "Focus", shortcut: commandShortcut(".", apple), run: () => setFocus((v) => !v) }]),
    ...(readOnly
      ? []
      : [
          { label: "New note", run: () => { afterClose.current = () => startCreate("mdx"); } },
          { label: "New drawing", run: () => { afterClose.current = () => startCreate("drawing"); } },
          { label: "New diagram", run: () => { afterClose.current = () => startCreate("diagram"); } },
          { label: "New folder", run: () => { afterClose.current = () => startCreate("folder"); } },
          ...(state.active ? [{ label: "Duplicate", shortcut: commandShortcut("d", apple), run: () => { if (state.active) void duplicateFile(state.active); } }] : []),
        ]),
  ];
  // Cmd+P's files: those in the tree, so a diagram's generated files stay out.
  const paletteFiles = hideGeneratedFiles(files.map((file) => file.path)).map((path) => ({ path, kind: kindForPath(path) }));
  // The menus below close before what they chose moves focus (a name
  // field, a dialog): it runs from afterClose, and keepMenuFocus stops the
  // menu taking focus back to its button.
  const closingMenu: ActionMenuProps = {
    onOpenChangeComplete: (open) => {
      if (!open) runAfterClose();
    },
    contentProps: {
      finalFocus: () => {
        const keep = keepMenuFocus.current;
        keepMenuFocus.current = false;
        return !keep;
      },
    },
  };
  // The project menu: the other projects and the way home (projectMenu), then this project's actions.
  // In a chat's panel, importing is on the site.
  const projectActions: MenuEntry[] = [
    ...(readOnly || embedded ? [] : [{ label: "Import a file", group: "actions", onSelect: () => fileInput.current?.click() }]),
    { label: "Refresh file list", group: "actions", onSelect: () => void refreshList() },
    {
      label: "Command palette",
      group: "actions",
      // Closing, the palette gives focus back to the project menu's button.
      onSelect: () => openPalette(projectPanel.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null),
    },
    ...(narrow ? [{ label: "Diagnostics", group: "actions", onSelect: () => setPanel((v) => !v) }] : []),
  ];
  const importInput = (
    <input
      ref={fileInput}
      type="file"
      className="sr-only"
      accept=".md,.mdx,.json,.excalidraw,.d2"
      aria-label="Import a file from this computer into the project"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFile(file);
      }}
    />
  );
  // On a desktop the name field opens and takes the keyboard at once, while
  // the menu is still closing, so letters typed straight away reach it. A
  // phone's name dialog waits for the menu to close.
  const newFromMenu = (kind: NewEntryKind) => {
    if (narrow) {
      afterMenu(() => startCreate(kind));
      return;
    }
    keepMenuFocus.current = true;
    startCreate(kind);
  };
  const newFileEntries: MenuEntry[] = [
    { label: "New note", onSelect: () => newFromMenu("mdx") },
    { label: "New drawing", onSelect: () => newFromMenu("drawing") },
    { label: "New diagram", onSelect: () => newFromMenu("diagram") },
  ];
  const agentCount = useConnectedAgentCount(!local && !embedded && auth.status === "ready");
  const person: PanelPerson | null = auth.status === "ready" ? personOf(auth.user, auth.email) : null;
  // In a chat's panel there is no Settings, and Connected agents are on the site.
  const personMenu: MenuEntry[] = [
    ...(embedded ? [] : [{ label: "Settings", onSelect: () => afterMenu(openSettings) }]),
    // On a phone the account panel has no Connected agents row.
    ...(narrow && !embedded ? [{ label: agentCount ? `Connected agents (${agentCount})` : "Connected agents", onSelect: () => void routerNavigate({ to: "/agents" }) }] : []),
    ...(onSyncNow ? [{ label: "Sync now", onSelect: onSyncNow }] : []),
    {
      label: "Sign out",
      onSelect: () => void signOut().catch((reason: unknown) => setNotice(`Not signed out: ${reason instanceof Error ? reason.message : String(reason)}`)),
    },
  ];
  // The project, the files and the account: down the side on a desktop, the files screen on a phone.
  const sidePanels = (
    <>
      <ProjectPanel
        ref={projectPanel}
        size={panelSize}
        name={projectName}
        menu={[...projectMenu, ...projectActions]}
        menuProps={closingMenu}
        onShare={onShare}
        actions={<AgentChangesEntry size={panelSize} />}
        local={local}
        notices={projectNotices}
      >
        {importInput}
      </ProjectPanel>
      <FilesPanel size={panelSize}>
        <FileSearch
          size={panelSize}
          search={local ? null : searchFiles}
          unavailable={local ? <SignUpTo>Sign up to search</SignUpTo> : undefined}
          onOpen={(path) => void openFromNavigation(path)}
          actions={!readOnly && <NewButtons size={panelSize} newFile={newFileEntries} menuProps={closingMenu} onNewFolder={() => startCreate("folder")} />}
        >
          <TreeScroller>{explorerBody}</TreeScroller>
        </FileSearch>
      </FilesPanel>
      <AccountPanel
        size={panelSize}
        local={local}
        agentCount={agentCount ?? undefined}
        onLookAndTheme={openSettings}
        person={person}
        menu={personMenu}
        menuProps={closingMenu}
        sync={sync}
      />
    </>
  );
  // On a phone: the open file's floating Back button, and the files screen,
  // which shows when it is asked for or when no file is open.
  const navigation = narrow ? <RoundIconButton label="Back to files and projects" onClick={() => setSidebar(true)}><ChevronLeft /></RoundIconButton> : null;
  // The bottom panel's lines (Ctrl+J): the project's files, the active file's state and its last message.
  const diagnostics = (
    <div className="flex flex-col gap-1.5 text-[13px] leading-normal text-muted-foreground">
      <p>Project files · {files.length} files · {state.tabs.length} open</p>
      <p>{state.active ? `${state.active}: ${state.tabs.find((tab) => tab.path === state.active)?.dirty ? "unsaved changes" : "saved"}` : "No active file"}</p>
      {state.active && messages[state.active] && <p>{messages[state.active]}</p>}
      <p>File saves use revision checks. This panel does not execute commands.</p>
    </div>
  );
  const focusKey = commandShortcut(".", isApplePlatform());
  const filesScreen = narrow && (sidebar || (!state.tabs.length && !hideSessions));
  return (
    <CommentsGuestProvider
      value={
        local
          ? {
              open: guestComments,
              onOpenChange: setGuestComments,
              signUp: (
                <Link to="/sign-up" className={buttonVariants({ variant: "secondary", size: narrow ? "touch" : "default" })}>
                  Sign up to comment
                </Link>
              ),
            }
          : null
      }
    >
    <SidebarProvider open={sidebar} onOpenChange={setSidebar} className="wb-sidebar-provider">
    <div
      className="wb-app"
      data-compact={narrow}
      data-focus={focus && !narrow}
      data-comment-draft={(narrow && commentsUi.panelOpen && commentsUi.request !== null) || undefined}
      ref={shell}
    >
      <div className="wb-body" inert={filesScreen}>
        <ResizablePanelGroup
          orientation="horizontal"
          className="wb-horizontal-panels"
          resizeTargetMinimumSize={{ fine: 8, coarse: 40 }}
          onLayoutChanged={(_layout, meta) => {
            if (meta.isUserInteraction && explorerPanel.current)
              setExplorerWidth(explorerPanel.current.getSize().inPixels);
          }}
        >
          {sidebar && !narrow && !focus && (
            <ResizablePanel
              id="explorer"
              panelRef={explorerPanel}
              defaultSize={`${explorerWidth}px`}
              minSize="180px"
              maxSize="520px"
              groupResizeBehavior="preserve-pixel-size"
              className="wb-explorer-panel"
            >
              <div className="flex h-full min-h-0 flex-col gap-3">{sidePanels}</div>
            </ResizablePanel>
          )}
          {sidebar && !narrow && !focus && (
            <ResizableHandle aria-label="Resize explorer" />
          )}
          <ResizablePanel
            id="workbench-editor"
            minSize={narrow ? "0%" : "320px"}
            className="wb-main-panel"
          >
            <main className="wb-main">
              {narrow && navigationOutsideSession && <PhoneHeader back={navigation} className="relative" />}
              {/* One Tabs root for the tab line and the files' panels; sessions
              stay mounted in keepMounted panels. */}
              <TablineProvider slot={narrow ? null : tablineSlot}>
              <Tabs
                value={hideSessions ? "" : (state.active ?? "")}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) selectTab(value);
                }}
              >
              {/* The top line: the open files, then the open file's view
              switch and Save (its view puts them in the slot), then Focus.
              In focus mode it floats at the top right with only the file's
              controls and the way out. (wb-tabline: the full-bleed canvas
              rules float it as a panel of its own.) */}
              <EditorHeader
                variant={focus && !narrow ? "floating" : "line"}
                className={narrow ? "hidden" : focus ? "fixed top-4 right-4 z-30" : "wb-tabline"}
              >
              <TabStrip
                tabs={state.tabs}
                active={state.active}
                tabId={tabId}
                reorder={tabReorder}
                onSelect={selectTab}
                onClose={closeTab}
                className={focus ? "hidden" : undefined}
              />
              {!narrow && <div className="contents" ref={setTablineSlot} />}
              {!narrow && state.active && !hideSessions && <CommentsToggle />}
              {!narrow && (
                <IconButton label={focus ? "Exit full screen" : "Focus"} shortcut={focusKey.label} keyShortcuts={focusKey.aria} onClick={() => setFocus((v) => !v)}>
                  {focus ? <Minimize2 /> : <Maximize2 />}
                </IconButton>
              )}
              </EditorHeader>
              {notice && <Banner tone="info" className="wb-notice">{notice}</Banner>}
              {(linkProblem || awaitingTarget) && (
                <Banner
                  tone={linkProblem ? "warn" : "info"}
                  role={linkProblem ? "alert" : "status"}
                  className="wb-notice"
                  action={
                    <span className="inline-flex flex-wrap gap-x-3">
                      {linkProblem && !invalidLink && <BannerAction onClick={() => setRetryLocation(n => n + 1)}>Retry file</BannerAction>}
                      <BannerAction onClick={() => setSidebar(true)}>Open explorer</BannerAction>
                      {state.active && <BannerAction onClick={() => void navigate(projectId, state.tabs.find(tab => tab.path === state.active)?.revision ? state.active : null, true)}>Return to current file</BannerAction>}
                    </span>
                  }
                >
                  {linkProblem ?? `Opening ${targetPath}…`}
                </Banner>
              )}
              <ResizablePanelGroup
                orientation="vertical"
                className="wb-vertical-panels"
                resizeTargetMinimumSize={{ fine: 8, coarse: 40 }}
                onLayoutChanged={(_layout, meta) => {
                  if (meta.isUserInteraction && bottomPanel.current)
                    setBottomHeight(bottomPanel.current.getSize().inPixels);
                }}
              >
                <ResizablePanel
                  id="editor-sessions"
                  minSize="35%"
                  className="wb-sessions-panel"
                >
                  <div className="wb-sessions">
                    {state.tabs.map((tab) => (
                      <TabsContent
                        key={`${tab.path}:${tab.generation ?? 0}`}
                        value={tab.path}
                        keepMounted
                        aria-label={tab.path}
                        className="wb-session-host"
                      >
                        {kindForPath(tab.path) === "diagram" ? (
                          <DiagramView
                            navigation={!navigationOutsideSession && state.active === tab.path ? navigation : null}
                            client={client}
                            initial={tab}
                            active={!hideSessions && state.active === tab.path}
                            onState={onState}
                            onOperationSession={registerSession}
                            savedRevision={files.find((file) => file.path === tab.path)?.revision}
                            conflicted={files.find((file) => file.path === tab.path)?.conflict ?? false}
                            onResolveConflict={onResolveConflict ? (choice) => onResolveConflict(tab.path, choice) : undefined}
                            onDuplicate={readOnly ? undefined : () => void duplicateFile(tab.path)}
                            readOnly={readOnly}
                          />
                        ) : kindForPath(tab.path) === "drawing" ? (
                          <DrawingView
                            navigation={!navigationOutsideSession && state.active === tab.path ? navigation : null}
                            client={client}
                            initial={tab}
                            active={!hideSessions && state.active === tab.path}
                            onState={onState}
                            onOperationSession={registerSession}
                            savedRevision={files.find((file) => file.path === tab.path)?.revision}
                            conflicted={files.find((file) => file.path === tab.path)?.conflict ?? false}
                            onResolveConflict={onResolveConflict ? (choice) => onResolveConflict(tab.path, choice) : undefined}
                            onDuplicate={readOnly ? undefined : () => void duplicateFile(tab.path)}
                            readOnly={readOnly}
                          />
                        ) : (
                          <WorkspaceSession
                            navigation={!navigationOutsideSession && state.active === tab.path ? navigation : null}
                            client={client}
                            initial={tab}
                            workspacePaths={files.map((file) => file.path)}
                            active={!hideSessions && state.active === tab.path}
                            onOpen={openPath}
                            refreshList={refreshFiles}
                            onState={onState}
                            onOperationSession={registerSession}
                            savedRevision={files.find((file) => file.path === tab.path)?.revision}
                            server={files.find((file) => file.path === tab.path)?.server ?? null}
                            conflicted={files.find((file) => file.path === tab.path)?.conflict ?? false}
                            onResolveConflict={onResolveConflict ? (choice) => onResolveConflict(tab.path, choice) : undefined}
                            onDuplicate={readOnly ? undefined : () => void duplicateFile(tab.path)}
                            readOnly={readOnly}
                          />
                        )}
                      </TabsContent>
                    ))}
                    {!state.tabs.length && !hideSessions && (
                      <EmptyState
                        icon={<Diamond />}
                        title="A place for connected ideas."
                        description={readOnly ? "Open a file to read it." : "Open a file or create a note to begin."}
                        actions={(!sidebar || !readOnly) && (
                          <>
                            {!sidebar && <Button variant="secondary" onClick={() => setSidebar(true)}>Open explorer</Button>}
                            {!readOnly && <Button onClick={() => startCreate("mdx")}>New note</Button>}
                          </>
                        )}
                      />
                    )}
                  </div>
                </ResizablePanel>
                {panel && !narrow && <ResizableHandle aria-label="Resize bottom panel" />}
                {panel && !narrow && (
                  <ResizablePanel
                    id="diagnostics"
                    panelRef={bottomPanel}
                    defaultSize={`${bottomHeight}px`}
                    minSize="100px"
                    maxSize="60%"
                    groupResizeBehavior="preserve-pixel-size"
                    className="wb-diagnostics-panel"
                  >
                    <section aria-labelledby={`${tabListId}-diagnostics`} className="h-full overflow-auto border-t border-border bg-panel px-4 pb-3 [overflow-wrap:anywhere]">
                      <div className="flex h-10 items-center justify-between">
                        <h2 id={`${tabListId}-diagnostics`} className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Diagnostics</h2>
                        <IconButton label="Close bottom panel" tooltipSide="top" onClick={() => setPanel(false)}>
                          <X />
                        </IconButton>
                      </div>
                      {diagnostics}
                    </section>
                  </ResizablePanel>
                )}
              </ResizablePanelGroup>
              </Tabs>
              </TablineProvider>
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
        {/* The comments float beside the editor, 16 from it; in focus mode below its floating controls. */}
        {!narrow && !hideSessions && state.active && (
          <CommentsSurface compact={false} className={cn("relative z-[1] ml-4", focus && "mt-[60px] h-[calc(100%-60px)]")} />
        )}
      </div>
      {narrow && !hideSessions && state.active && <CommentsSurface compact />}
      {filesScreen && (
        <section aria-label="Files and projects" data-files-screen="" className="absolute inset-0 z-40 overflow-y-auto overscroll-contain">
        <DottedPage className="flex min-h-full flex-col gap-2.5 pt-[calc(12px+env(safe-area-inset-top))] pr-[calc(12px+env(safe-area-inset-right))] pb-[calc(12px+env(safe-area-inset-bottom))] pl-[calc(12px+env(safe-area-inset-left))]">
          {sidePanels}
          {panel && (
            <FloatingPanel variant="flat" render={<section aria-label="Diagnostics" />} className="shrink-0 px-3 py-2 [overflow-wrap:anywhere]">
              {diagnostics}
            </FloatingPanel>
          )}
          {notice && <Banner tone="info">{notice}</Banner>}
        </DottedPage>
        </section>
      )}
      <AgentChangesSurface compact={narrow} workspace={client} readOnly={readOnly} onOpenFile={(path) => void openFromNavigation(path)} />
      <QuickOpen
        open={palette}
        onOpenChange={setPalette}
        onOpenChangeComplete={(open) => { if (!open) runAfterClose(); }}
        mode={paletteMode}
        onModeChange={setPaletteMode}
        files={paletteFiles}
        onOpen={(path) => void openFromNavigation(path)}
        commands={commands}
        finalFocus={() => { if (afterClose.current === null) paletteInvoker.current?.focus({ preventScroll: true }); return false; }}
        // Beside the side panels, it sits a little right of centre, over the editor.
        className={sidebar && !focus && !narrow ? "sm:-translate-x-[40%]" : undefined}
      />
      {creating && narrow && (
        <RenameDialog
          key={creating.key}
          open
          title={`New ${newEntryNoun(creating.kind)} in ${creating.dir === "" ? "Workspace root" : creating.dir}`}
          description={creating.kind === "folder" ? "Choose a name for the new folder." : `Choose a name for the new ${newEntryNoun(creating.kind)}. It is saved at once.`}
          label="Name"
          initial={creating.initial}
          selectLength={nameStemLength(creating.kind, creating.initial)}
          validate={validateNew(creating)}
          onRename={(name) => createEntry(creating, name)}
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          submitLabel="Create"
          pendingLabel="Creating…"
        />
      )}
      {moves.target && <LazyMoveDialog path={moves.target} kind={moves.kind} folders={directories} folder={moves.folder}
        plan={moves.plan} pending={moves.pending} error={moves.error} stale={moves.stale}
        onFolder={moves.changeFolder} onPreview={() => void moves.preview()}
        onCommit={() => void moves.commit()} onClose={moves.close} />}
      {deletes.request && <DeleteDialog request={deletes.request} plan={deletes.plan} pending={deletes.pending} deleting={deletes.deleting}
        error={deletes.error} stale={deletes.stale} onCommit={deletes.commit} onClose={deletes.close} />}

    </div>
    </SidebarProvider>
    </CommentsGuestProvider>
  );
}

/** The signed-in person as the account panel shows them, by the name comments and members show (personName). */
function personOf(user: { user_metadata?: Record<string, unknown> }, email: string | null): PanelPerson {
  const meta = user.user_metadata ?? {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    name: personName(accountName(meta), email) ?? "Signed in",
    email: email ?? "",
    image: text(meta.avatar_url),
  };
}
