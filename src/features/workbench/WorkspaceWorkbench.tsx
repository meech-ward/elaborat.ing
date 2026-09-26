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
import { createPortal } from "react-dom";
import { ReadingSettings } from "../appearance";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Dialog } from "@base-ui/react/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useTabReorder } from "./useTabReorder";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Diamond,
  Files,
  Search,
  PanelLeft,
  PanelBottom,
  Sun,
  X,
  FolderPlus,
  FolderSync,
  FilePlus,
  FileUp,
  Terminal,
} from "lucide-react";
import { themes, useAppearance, type ThemeName } from "@/features/appearance";
import { AccountMenu } from "@/features/auth";
import { isValidProjectPath } from "@/features/project-storage/model";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { parseDrawingFile } from "@/features/drawings/parse";
import { readChosenFile } from "@/lib/fileAdapter";
import { kindForPath, suggestUntitledName } from "./session";
import { WorkspaceSession } from "./WorkspaceSession";
import { ActionMenu } from "./WorkbenchChrome";
import { useCompactWorkbench, useSheetViewport } from "./compactWorkbench";
import { ExplorerTree } from "./ExplorerTree";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { prepareProjectLeave, type PrepareProjectLeave } from "./projectLeave";
import type { OperationSession } from "./operationSession";
import type { WorkspaceFileRef, WorkspaceStore } from "./workspaceStore";
import {
  ancestorsOf,
  buildFolderTree,
  joinFolder,
  revealAncestors,
} from "./folderTree";
import {
  MAX_EXPANDED_FOLDERS,
  defaultFolderPreferences,
  pruneFolderPreferences,
  readFolderPreferences,
  writeFolderPreferences,
  type FolderPreferences,
} from "./folderPreferences";
import { type TabFile } from "./tabs";
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
 * command palette. `projectHeader` shows in the title bar and in the phone
 * navigation sheet.
 */
export function WorkspaceWorkbench({
  client,
  onLeaveGuard,
  projectId,
  projectHeader,
  onResolveConflict,
}: {
  client: WorkspaceStore;
  onLeaveGuard?: (guard: PrepareProjectLeave | null) => void;
  projectId: string;
  projectHeader?: ReactNode;
  onResolveConflict?: (path: string, choice: ConflictChoice) => Promise<void>;
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
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(false);
  const narrow = useCompactWorkbench();
  const navigationButton = useRef<HTMLButtonElement>(null);
  const sheetClose = useRef<HTMLButtonElement>(null);
  // Element that opened the command palette; Escape/focus return goes here.
  const paletteInvoker = useRef<HTMLElement | null>(null);
  const workbenchMenuButton = useRef<HTMLButtonElement>(null);
  const openPalette = (invoker: HTMLElement | null) => {
    paletteInvoker.current = invoker;
    setPalette(true);
  };
  const sheetViewport = useSheetViewport(narrow && sidebar);
  const explorerPanel = usePanelRef();
  const bottomPanel = usePanelRef();
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [bottomHeight, setBottomHeight] = useState(190);
  const [palette, setPalette] = useState(false);
  const [readingSettings, setReadingSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Record<string, string | null>>({});
  const { appearance, setTheme, toggleScheme } = useAppearance();
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
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderPending, setFolderPending] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
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
  const selectFolder = useCallback((path: string) => {
    setFolderPrefs((prev) =>
      prev.selectedFolder === path ? prev : { ...prev, selectedFolder: path },
    );
  }, []);
  const refreshFiles = useCallback(async () => { await refreshList(); }, [refreshList]);
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
      const missing: string[] = [];
      const transient: string[] = [];
      for (const result of results) {
        if (closedDuringRestore.current.has(result.path)) continue;
        if (result.ok) successes.push(result);
        else if (isMissingFileError(result.error)) missing.push(result.path);
        else transient.push(result.path);
      }
      unresolvedRestore.current = transient;
      const current = locationRef.current.target;
      dispatch({ type: "restored", files: successes, order: stored?.openPaths, activePath: stored?.activePath ?? defaultFile?.path ?? null,
        activate: !interacted.current && current.kind === "workspace" && current.path === null });
      restoreDone.current = true;
      setPersistReady(true);
      if (transient.length) setNotice(`Could not restore ${transient.length} tab(s) due to a temporary error; remembered tabs kept. Refresh to retry.`);
      else if (missing.length) setNotice(`Skipped ${missing.length} missing file(s): ${missing.join(", ")}.`);
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
  const createFile = useCallback(
    async (kind: "note" | "mdx") => {
      const existing = [
        ...files.map((file) => file.path),
        ...state.tabs.map((tab) => tab.path),
      ];
      // The selected folder ("", the explicit root, included) is where new
      // files go. Collision checks cover saved files and open tabs.
      const dir = folderPrefs.selectedFolder ?? "";
      const path = suggestUntitledName(existing, kind === "mdx" ? ".mdx" : ".md", dir);
      try {
        await client.persistDrafts([{ path, content: "", baseRevision: null }]);
        addDraft({ path, content: "", revision: null });
      } catch (error) { setNotice(`Create failed: ${String(error)}`); }
    },
    [addDraft, client, files, folderPrefs.selectedFolder, state.tabs],
  );
  const openFolderDialog = useCallback(() => {
    setFolderError(null);
    setFolderDialog(true);
  }, []);
  // One named child of the selected existing directory (or the root).
  // Success refreshes the authoritative list, reveals the new folder, and
  // selects it for subsequent creation; refusal stays visible in the open
  // dialog and changes no file.
  const createFolder = useCallback(
    async (name: string) => {
      const parent = folderPrefs.selectedFolder ?? "";
      setFolderPending(true);
      setFolderError(null);
      try {
        const created = await client.createDirectory(joinFolder(parent, name));
        await refreshList();
        setFolderPrefs((prev) => ({
          selectedFolder: created.path,
          // Reveal the new folder itself by revealing a file inside it.
          expanded: revealAncestors(
            prev.expanded,
            joinFolder(created.path, "untitled"),
          ),
        }));
        setFolderDialog(false);
        setNotice(`Created folder ${created.path}.`);
      } catch (error) {
        setFolderError(
          `Could not create the folder: ${error instanceof Error ? error.message : String(error)} No files were changed.`,
        );
      } finally {
        setFolderPending(false);
      }
    },
    [client, folderPrefs.selectedFolder, refreshList],
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
  const closeTab = (path: string) => {
    const tab = state.tabs.find((tab) => tab.path === path);
    if (
      tab?.dirty &&
      !window.confirm(
        `Close ${path} and discard unsaved changes? Cancel to keep editing or save first.`,
      )
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
      if (key === "b" || key === "j" || key === "`" || key === "k") {
        event.preventDefault();
        event.stopPropagation();
        if (key === "b") setSidebar((v) => !v);
        else if (key === "k") {
          if (!palette && document.activeElement instanceof HTMLElement)
            paletteInvoker.current = document.activeElement;
          setPalette((v) => !v);
        }
        else { setPanel((v) => !v); if (narrow) setSidebar(true); }
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [narrow, palette]);
  // Open unsaved tabs that are not server files appear in the visual
  // tree marked as drafts, without posing as saved files.
  const targetPath = target.kind === "workspace" && target.projectId === projectId ? target.path : null;
  const invalidLink = target.kind === "invalid" ? target.message
    : target.projectId !== projectId ? "That link is for another project." : null;
  const linkProblem = invalidLink ?? (locationProblem?.href === href ? locationProblem.message : null);
  const awaitingTarget = Boolean(targetPath && targetPath !== state.active);
  const hideSessions = Boolean(linkProblem || awaitingTarget);
  const navigationOutsideSession = hideSessions;
  const openFromNavigation = async (path: string) => {
    if (await openPath(path)) { if (narrow) setSidebar(false); }
  };
  const serverPaths = new Set(files.map((file) => file.path));
  const draftPaths = state.tabs
    .filter((tab) => tab.revision === null && !serverPaths.has(tab.path))
    .map((tab) => tab.path);
  const tree = buildFolderTree(
    files.map((file) => file.path),
    directories,
    draftPaths,
  );
  const treeIsEmpty =
    tree.folders.length === 0 && tree.rootFiles.length === 0;
  // One explorer implementation for the desktop sidebar and the 390px
  // phone overlay: loading, error-with-retry, tree, and empty states.
  const renderExplorerBody = () => (
    <>
      {!listed && !listError && <p role="status">Loading files…</p>}
      {listError && (
        <div className="wb-explorer-error">
          <p role="alert">File list failed: {listError}</p>
          <button onClick={() => void refreshList()}>Retry</button>
        </div>
      )}
      {(listed || !listError) && (
        <ExplorerTree
          tree={tree}
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
          onOpenFile={(path) => void openFromNavigation(path)}
          onFeedback={setNotice}
        />
      )}
      {listed && !listError && treeIsEmpty && (
        <p>No files yet. Create a note to start.</p>
      )}
    </>
  );
  const commands = [
    { name: "Toggle explorer", run: () => setSidebar((v) => !v) },
    { name: "Toggle bottom panel", run: () => setPanel((v) => !v) },
    { name: "New note", run: () => void createFile("note") },
    { name: "New MDX note", run: () => void createFile("mdx") },
    { name: "New folder", run: openFolderDialog },
    ...files.map((file) => ({
      name: `Open ${file.path}`,
      run: () => void openFromNavigation(file.path),
    })),
  ];
  const workbenchControls = (
      <header className="wb-titlebar">
        <span className="wb-brand">
          <Diamond size={19} /> elaborat.ing
        </span>
        {/* On a phone the navigation sheet shows the project header at its top instead. */}
        {!narrow && projectHeader}
        <select
          aria-label="Theme direction"
          value={appearance.theme}
          onChange={(e) => setTheme(e.target.value as ThemeName)}
        >
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
            </option>
          ))}
        </select>
        <button
          className="wb-command"
          aria-label="Open workspace commands"
          onClick={(e) => openPalette(e.currentTarget)}
        >
          <Search size={14} />
          <span>Workspace</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="wb-layout-actions">
          <button
            className="wb-icon"
            aria-label="Toggle explorer"
            aria-pressed={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <PanelLeft size={17} />
          </button>
          <button
            className="wb-icon"
            aria-label="Toggle bottom panel"
            aria-pressed={panel}
            onClick={() => setPanel(!panel)}
          >
            <PanelBottom size={17} />
          </button>
        </div>
        <ActionMenu label="Workbench menu" triggerRef={workbenchMenuButton}>
          <button onClick={() => void createFile("note")}>
            <FilePlus size={14} /> New
          </button>
          <button onClick={() => void createFile("mdx")}><FilePlus size={14} /> New MDX note</button>
          <button onClick={() => fileInput.current?.click()}>
            <FileUp size={14} /> Import
          </button>
          <button onClick={openFolderDialog}>
            <FolderPlus size={14} /> New folder
          </button>
          <button onClick={() => void refreshList()}>
            <FolderSync size={14} /> Refresh file list
          </button>
          <button onClick={() => openPalette(workbenchMenuButton.current)}>Command palette</button>
          <button onClick={() => setReadingSettings(true)}>
            Reading preferences
          </button>
        </ActionMenu>
        <AccountMenu />
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
      </header>
  );
  const navigation = narrow ? <button type="button" ref={navigationButton} className="wb-icon" data-compact-nav="" aria-label="Navigation" aria-haspopup="dialog" aria-expanded={sidebar} onClick={() => setSidebar(true)}><PanelLeft size={20} /></button> : null;
  return (
    <SidebarProvider open={sidebar} onOpenChange={setSidebar} className="wb-sidebar-provider">
    <div className="wb-app" data-compact={narrow} ref={shell}>
      {!narrow && workbenchControls}
      <div className="wb-body">
        <nav className="wb-rail" aria-label="Activity bar">
          <button
            className="wb-icon"
            aria-label="Explorer"
            aria-pressed={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <Files size={21} />
          </button>
          <button
            className="wb-icon"
            aria-label="Find a file or command"
            onClick={(e) => openPalette(e.currentTarget)}
          >
            <Search size={21} />
          </button>
          <button
            className="wb-icon"
            aria-label="Diagnostics"
            aria-pressed={panel}
            onClick={() => setPanel(!panel)}
          >
            <Terminal size={20} />
          </button>
          <span />
          <button
            className="wb-icon"
            aria-label={`Switch to ${appearance.scheme === "dark" ? "light" : "dark"} mode`}
            onClick={toggleScheme}
          >
            <Sun size={20} />
          </button>
        </nav>
        <ResizablePanelGroup
          orientation="horizontal"
          className="wb-horizontal-panels"
          resizeTargetMinimumSize={{ fine: 8, coarse: 40 }}
          onLayoutChanged={(_layout, meta) => {
            if (meta.isUserInteraction && explorerPanel.current)
              setExplorerWidth(explorerPanel.current.getSize().inPixels);
          }}
        >
          {sidebar && !narrow && (
            <ResizablePanel
              id="explorer"
              panelRef={explorerPanel}
              defaultSize={`${explorerWidth}px`}
              minSize="180px"
              maxSize="520px"
              groupResizeBehavior="preserve-pixel-size"
              className="wb-explorer-panel"
            >
              <Sidebar collapsible="none">
              <nav className="wb-explorer" aria-label="Workspace files">
                <SidebarHeader className="wb-explorer-title">
                  Explorer
                  <span className="wb-explorer-actions">
                    <button
                      className="wb-icon"
                      aria-label="New folder"
                      title="New folder"
                      onClick={openFolderDialog}
                    >
                      <FolderPlus size={15} />
                    </button>
                    <button
                      className="wb-icon"
                      aria-label="Close explorer"
                      onClick={() => setSidebar(false)}
                    >
                      <X size={15} />
                    </button>
                  </span>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>Files</SidebarGroupLabel>
                    <SidebarGroupContent>
                      {renderExplorerBody()}
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
              </nav>
              </Sidebar>
            </ResizablePanel>
          )}
          {sidebar && !narrow && (
            <ResizableHandle aria-label="Resize explorer" />
          )}
          <ResizablePanel
            id="workbench-editor"
            minSize={narrow ? "0%" : "320px"}
            className="wb-main-panel"
          >
            <main className="wb-main">
              {narrow && (!state.tabs.length || navigationOutsideSession) && <div className="wb-compact-empty-toolbar">{navigation}<span>Workspace</span></div>}
              {/* Close buttons are sibling commands, not tabs. Explicit ownership
              groups only the file tabs without changing the mixed-control strip.
              Sessions stay mounted below inside TabsContent keepMounted panels. */}
              <Tabs
                value={hideSessions ? "" : (state.active ?? "")}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) selectTab(value);
                }}
              >
              <TabsList className="wb-tabs" aria-label="Open files" activateOnFocus {...tabReorder.handlers} data-reordering={tabReorder.visual?.animateNeighbors ?? false}>
                {state.tabs.map((tab) => (
                  <div
                    className="wb-tab"
                    data-tab-path={tab.path}
                    data-tab-dragging={tabReorder.visual?.path === tab.path}
                    style={{ transform: `translateX(${tabReorder.visual?.offsets[tab.path] ?? 0}px)` }}
                    data-selected={tab.path === state.active}
                    key={tab.path}
                  >
                    {/* A tab list may hold only tabs, so the close mark sits inside
                    the tab as a pointer target; from the keyboard, Delete closes
                    the focused tab (and the phone navigation lists close buttons). */}
                    <TabsTrigger
                      value={tab.path}
                      id={tabId(tab.path)}
                      aria-label={tab.path}
                      title={`${tab.path} · Drag to reorder; Alt+Shift+Left/Right moves the focused tab; Delete closes it`}
                      aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                      onKeyDown={(event) => {
                        if (event.key !== "Delete") return;
                        event.preventDefault();
                        closeTab(tab.path);
                      }}
                    >
                      {tab.path.split("/").pop()}
                      {tab.dirty && <span aria-label="unsaved changes">●</span>}
                      <span
                        aria-hidden="true"
                        className="wb-tab-close"
                        data-tab-close={tab.path}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(tab.path);
                        }}
                      >
                        <X size={12} />
                      </span>
                    </TabsTrigger>
                  </div>
                ))}
              </TabsList>
              {tabReorder.visual && createPortal(
                <div className="wb-tab-ghost" aria-hidden="true" data-settling={tabReorder.visual.settling}
                  style={{ left: tabReorder.visual.left, top: tabReorder.visual.top, width: tabReorder.visual.width, height: tabReorder.visual.height }}>
                  <span>{tabReorder.visual.path.split("/").pop()}</span>
                  {state.tabs.find(tab => tab.path === tabReorder.visual?.path)?.dirty && <span>●</span>}
                  <X size={12} />
                </div>, document.body,
              )}
              {notice && (
                <p role="status" className="wb-notice">
                  {notice}
                </p>
              )}
              {(linkProblem || awaitingTarget) && <div className="wb-notice" role={linkProblem ? "alert" : "status"}>
                <p>{linkProblem ?? `Opening ${targetPath}…`}</p>
                {linkProblem && !invalidLink && <button type="button" className="min-h-10 px-3" onClick={() => setRetryLocation(n => n + 1)}>Retry file</button>}
                <button type="button" className="min-h-10 px-3" onClick={() => setSidebar(true)}>Open explorer</button>
                {state.active && <button type="button" className="min-h-10 px-3" onClick={() => void navigate(projectId, state.tabs.find(tab => tab.path === state.active)?.revision ? state.active : null, true)}>Return to current file</button>}
              </div>}
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
                          conflicted={files.find((file) => file.path === tab.path)?.conflict ?? false}
                          onResolveConflict={onResolveConflict ? (choice) => onResolveConflict(tab.path, choice) : undefined}
                        />
                      </TabsContent>
                    ))}
                    {!state.tabs.length && !hideSessions && (
                      <div className="wb-empty">
                        <Diamond size={32} />
                        <h1>A place for connected ideas.</h1>
                        <p>Open a file or create a note to begin.</p>
                        <button onClick={() => setSidebar(true)}>
                          Open explorer
                        </button>
                        <button onClick={() => void createFile("note")}>
                          New note
                        </button>
                        <button onClick={() => void createFile("mdx")}>New MDX note</button>
                      </div>
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
                    <section aria-label="Bottom panel" className="wb-panel">
                      <div>
                        <span>DIAGNOSTICS</span>
                        <button
                          className="wb-icon"
                          aria-label="Close bottom panel"
                          onClick={() => setPanel(false)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <p>
                        Project files · {files.length} files ·{" "}
                        {state.tabs.length} open
                      </p>
                      <p>
                        {state.active
                          ? `${state.active}: ${state.tabs.find((tab) => tab.path === state.active)?.dirty ? "unsaved changes" : "saved"}`
                          : "No active file"}
                      </p>
                      {state.active && messages[state.active] && (
                        <p>{messages[state.active]}</p>
                      )}
                      <p>
                        File saves use revision checks. This panel does not
                        execute commands.
                      </p>
                    </section>
                  </ResizablePanel>
                )}
              </ResizablePanelGroup>
              </Tabs>
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Sheet open={narrow && sidebar} onOpenChange={setSidebar}>
          <SheetContent ref={sheetViewport} side="left" showCloseButton={false} overlayClassName="wb-navigation-backdrop" className="wb-navigation-sheet" data-compact-sheet="" data-compact="true" initialFocus={sheetClose} finalFocus={() => { navigationButton.current?.focus({ preventScroll: true }); return false; }}>
            <div className="wb-navigation-heading">
              <SheetTitle>Navigation</SheetTitle>
              <SheetClose ref={sheetClose} className="wb-icon" data-compact-sheet-close="" aria-label="Close navigation"><X size={20} /></SheetClose>
            </div>
            <SheetDescription className="sr-only">Open files, project files and controls.</SheetDescription>
            <div className="wb-navigation-scroll">
              {projectHeader}
              <section aria-label="Open files" className="wb-navigation-tabs">
                <h3>Open files</h3>
                {state.tabs.length > 0 && (
                <SidebarMenu>
                {state.tabs.map((tab) => <SidebarMenuItem className="wb-navigation-tab" key={tab.path}>
                  <SidebarMenuButton type="button" data-open-file={tab.path} isActive={tab.path === state.active} aria-current={tab.path === state.active ? "page" : undefined} onClick={() => { selectTab(tab.path); setSidebar(false); }}>
                    <span>{tab.path}</span>{tab.dirty && <span aria-label="unsaved changes">●</span>}
                  </SidebarMenuButton>
                  <SidebarMenuAction type="button" aria-label={`Close ${tab.path}`} onClick={() => closeTab(tab.path)}><X size={16} /></SidebarMenuAction>
                </SidebarMenuItem>)}
                </SidebarMenu>
                )}
                {!state.tabs.length && <p>No open files.</p>}
              </section>
              <nav className="wb-explorer" aria-label="Workspace files">
                <div className="wb-explorer-title">Files <button className="wb-icon" aria-label="New folder" onClick={openFolderDialog}><FolderPlus size={18} /></button></div>
                {renderExplorerBody()}
              </nav>
              <section className="wb-navigation-tools" aria-label="Workbench controls">
                {workbenchControls}
                <button type="button" className="ph-btn" aria-label={`Switch to ${appearance.scheme === "dark" ? "light" : "dark"} mode`} onClick={toggleScheme}><Sun size={18} /> {appearance.scheme === "dark" ? "Light" : "Dark"} mode</button>
                <button type="button" className="ph-btn" aria-expanded={panel} onClick={() => setPanel(!panel)}>Diagnostics</button>
                {panel && <section aria-label="Bottom panel" className="wb-navigation-diagnostics">
                  <p>Project files · {files.length} files · {state.tabs.length} open</p>
                  <p>{state.active ? `${state.active}: ${state.tabs.find(tab => tab.path === state.active)?.dirty ? "unsaved changes" : "saved"}` : "No active file"}</p>
                  {state.active && messages[state.active] && <p>{messages[state.active]}</p>}
                  <p>File saves use revision checks. This panel does not execute commands.</p>
                </section>}
              </section>
              {notice && <p role="status" className="wb-notice">{notice}</p>}
            </div>
          </SheetContent>
      </Sheet>
      <footer className="wb-status">
        <span>Workspace</span>
        <span>
          {state.tabs.filter((tab) => tab.dirty).length} unsaved ·{" "}
          {appearance.theme} / {appearance.scheme}
        </span>
      </footer>
      <Dialog.Root open={palette} onOpenChange={(open) => { setPalette(open); if (!open) setQuery(""); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="wb-backdrop" />
          <Dialog.Popup className="wb-palette" finalFocus={() => { paletteInvoker.current?.focus({ preventScroll: true }); return false; }}>
            <Dialog.Title>Go anywhere</Dialog.Title>
            <Dialog.Description className="sr-only">
              Find a workspace file or command.
            </Dialog.Description>
            {/* cmdk always pins the input's aria-labelledby to its label
              element (shadowing aria-label), so the label itself carries the
              established "Search commands" name; the dialog title keeps
              naming the palette. */}
            <Command label="Search commands">
              <CommandInput
                autoFocus
                aria-label="Search commands"
                placeholder="Find a file or command…"
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                <CommandEmpty>No matching commands.</CommandEmpty>
                <CommandGroup>
                  {/* Command callbacks access refs only when invoked by onSelect. */}
                  {/* eslint-disable-next-line react-hooks/refs */}
                  {commands.map((command) => (
                    <CommandItem
                      key={command.name}
                      value={command.name}
                      onSelect={() => {
                        command.run();
                        setPalette(false);
                        setQuery("");
                      }}
                    >
                      {command.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
            <Dialog.Close>Close</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <CreateFolderDialog
        open={folderDialog}
        parent={folderPrefs.selectedFolder ?? ""}
        existingDirs={directories}
        filePaths={files.map((file) => file.path)}
        pending={folderPending}
        serverError={folderError}
        onSubmit={(name) => void createFolder(name)}
        onOpenChange={(next) => {
          if (!next) setFolderError(null);
          setFolderDialog(next);
        }}
      />
      <ReadingSettings
        open={readingSettings}
        onOpenChange={setReadingSettings}
      />
    </div>
    </SidebarProvider>
  );
}
