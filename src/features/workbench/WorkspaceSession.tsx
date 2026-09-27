import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OperationSession } from "./operationSession";
import { Save, Copy, Download, RefreshCw } from "lucide-react";
import { MenuShortcut } from "@/components/ui/menu";
import { ActionMenu } from "./WorkbenchChrome";
import { TablineActions } from "./tabline";
import { CompactFileIdentity, useCompactWorkbench } from "./compactWorkbench";
import type { TabFile } from "./tabs";
import { SourceEditor, type SourceEditorApi } from "@/features/source";
import type { SourcePatch } from "@/features/document";
import { RenderedEditor } from "@/features/rendered";
import type { RenderedPatchOptions } from "../source/renderedHistory";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { ConflictBanner } from "./ConflictBanner";
import type { WorkspaceStore } from "./workspaceStore";
import { createDocumentStore, type StoreState } from "@/lib/documentStore";
import { formatForFilename, saveSourceText } from "@/lib/fileAdapter";
import { diagnoseSource } from "@/lib/sourceDiagnostics";
import { parseSourceRefs } from "./refs";
import { diagramSvgForWorkspace, drawingSvgForContent } from "./resources";
import { readProjectView, writeProjectView } from "./projectViews";
import { ViewSwitcher } from "./ViewSwitcher";
import { ariaShortcut, duplicateShortcutLabel, isApplePlatform, shortcutLabel, viewShortcutDigit } from "./viewShortcuts";
import { useComponentEnvironment } from '../document/useComponentEnvironment';
import { savedComponentSource } from '../document/componentModules';
import {
  applyReload,
  clearSave,
  editorLanguageForPath,
  kindForPath,
  markConflict,
  markSaved,
  markSaving,
  newUntitledNote,
  openWorkspaceFile,
  resolveSaveCompletion,
  saveTarget,
  type OpenFile,
} from "./session";

type Mode = "source" | "split" | "rendered";
/** A note's views, in switch and shortcut order (⌘⌥1 to 3, Ctrl+Alt+1 to 3). */
const NOTE_VIEWS = [
  { value: "source", label: "Source" },
  { value: "split", label: "Split" },
  { value: "rendered", label: "Rendered" },
] as const;

/**
 * One open file: its document, undo history and the revision its edits are
 * based on. Drawings open in `DrawingView` and D2 diagrams in `DiagramView`
 * instead; other files open here as text.
 */
export function WorkspaceSession({
  client,
  initial,
  active,
  workspacePaths,
  onOpen,
  refreshList,
  onState,
  onOperationSession,
  blocked = false,
  navigation,
  savedRevision,
  conflicted = false,
  onResolveConflict,
  onDuplicate,
  readOnly = null,
}: {
  client: WorkspaceStore;
  initial: TabFile;
  active: boolean;
  workspacePaths: readonly string[];
  onOpen: (path: string) => void;
  refreshList: () => Promise<void>;
  onState: (path: string, dirty: boolean, notice: string | null) => void;
  onOperationSession?: (path: string, session: OperationSession | null) => void;
  blocked?: boolean;
  navigation?: ReactNode;
  /** The saved copy's revision in the latest file list; a change made elsewhere shows up here. */
  savedRevision?: string | null;
  /** Sync found this file changed in two places. */
  conflicted?: boolean;
  onResolveConflict?: (choice: ConflictChoice) => Promise<void>;
  /** Copies the file, as it is on screen, next to itself and opens the copy. Absent when read-only. */
  onDuplicate?: () => void;
  /** Why the project cannot be changed (a viewer, or an archived project), or null. The file is then shown, never edited or kept as a draft. */
  readOnly?: string | null;
}) {
  const [store] = useState(() => {
    const store = createDocumentStore(
      initial.savedContent !== undefined ? initial.savedContent ?? "" : initial.revision ? initial.content : "",
      formatForFilename(initial.path),
    );
    if ((!initial.revision && initial.content) || initial.savedContent !== undefined) store.setText(initial.content);
    return store;
  });
  const [snapshot, setSnapshot] = useState<StoreState>(() => store.snapshot());
  const [openFile, setOpenFile] = useState<OpenFile>(() =>
    initial.revision
      ? openWorkspaceFile(initial.path, initial.revision)
      : { ...newUntitledNote(initial.path), kind: kindForPath(initial.path) },
  );
  const [mode, setMode] = useState<Mode>(() => {
    const stored = readProjectView(client.persistenceKey, initial.path);
    return stored === "rendered" || stored === "split" ? stored : "source";
  });
  // Split is desktop only: at compact widths a stored Split shows Rendered.
  const compact = useCompactWorkbench();
  const view: Mode = mode === "split" && compact ? "rendered" : mode;
  const [renderedEver, setRenderedEver] = useState(mode !== "source");
  useEffect(() => { writeProjectView(client.persistenceKey, initial.path, mode); }, [client.persistenceKey, initial.path, mode]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [componentGeneration, setComponentGeneration] = useState(0);
  const loadComponentSource = useCallback(async (path: string) => {
    const file = await client.read(path);
    return savedComponentSource({ ...file, revision: file.revision ?? "" });
  }, [client]);
  // A module saved in another tab, or brought in by sync, rebuilds the components.
  const subscribeToStore = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const componentState = useComponentEnvironment(snapshot.text, snapshot.format === 'mdx', loadComponentSource, componentGeneration, subscribeToStore);
  useEffect(() => {
    if (readOnly) return;
    let alive = true;
    void client.persistDrafts([{ path: initial.path, content: snapshot.text, baseRevision: openFile.baseRevision }]).catch((error: unknown) => {
      if (alive) setNotice(`Local draft could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { alive = false; };
  }, [client, initial.path, openFile.baseRevision, readOnly, snapshot.dirty, snapshot.text]);
  const editorApi = useRef<SourceEditorApi | null>(null);
  const [renderedPending, setRenderedPending] = useState(false);
  const renderedPendingRef = useRef(false);
  const pendingMode = useRef<Mode | null>(null);
  const handleRenderedPending = useCallback((pending: boolean) => {
    renderedPendingRef.current = pending;
    setRenderedPending(pending);
    if (!pending && pendingMode.current !== null) {
      const next = pendingMode.current;
      pendingMode.current = null;
      setMode(next);
      if (next !== 'source') setRenderedEver(true);
      setNotice(current => current === 'Finishing edit…' ? null : current);
    }
  }, []);
  const savingRef = useRef(false);
  const pendingOperation = useRef(0);
  const frozen = useRef(false);
  const locked = blocked || Boolean(readOnly);
  useLayoutEffect(() => { frozen.current = locked; }, [locked]);
  useLayoutEffect(() => {
    onOperationSession?.(initial.path, {
      state: () => ({dirty:store.snapshot().dirty, pending:renderedPendingRef.current || pendingOperation.current > 0,
          saving:savingRef.current || openFile.save.stage === "saving",
          reconciled:openFile.baseRevision !== null && openFile.save.stage !== "conflict" && openFile.serverChanged === null}),
      freeze: () => { frozen.current = true; },
      release: () => { frozen.current = locked; },
      persistDraft: async () => {
        if (readOnly) return;
        await client.persistDrafts([{ path: initial.path, content: store.snapshot().text, baseRevision: openFile.baseRevision }]);
      },
    });
    return () => onOperationSession?.(initial.path,null);
  }, [client,initial.path,locked,onOperationSession,openFile,readOnly,store]);

  const displayName = openFile.path ?? openFile.pendingName ?? "No file open";
  const isNote = openFile.kind === "note";
  const hasFile = saveTarget(openFile) !== null;
  const refs = useMemo(() => parseSourceRefs(snapshot.text), [snapshot.text]);
  const visibleRefs = useMemo(
    () => refs.filter((ref) => ref.path !== openFile.path),
    [refs, openFile.path],
  );
  const overallDirty = snapshot.dirty || renderedPending;

  useEffect(() => {
    if (!active) return;
    document.title = `${overallDirty ? "• " : ""}${displayName} · elaborat.ing`;
  }, [active, displayName, overallDirty]);

  useEffect(() => {
    if (!overallDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [overallDirty]);

  const resetEditorMessages = useCallback(() => {
    setRenderError(null);
    setSourceError(null);
    setPatchError(null);
    setNotice(null);
  }, []);

  const openPath = useCallback(
    (path: string) => {
      onOpen(path);
    },
    [onOpen],
  );
  useEffect(() => {
    onState(initial.path, overallDirty, notice);
  }, [initial.path, overallDirty, notice, onState]);

  // Pictures of the drawings and diagrams the note embeds (at most eight),
  // made from their saved files here; only the SVG reaches the note frame.
  // Prose edits do not change them; returning to the note refreshes them.
  const resourceTargetsKey = JSON.stringify(
    refs
      .filter((ref) => (ref.kind === "drawing" || ref.kind === "diagram") && ref.path !== openFile.path)
      .slice(0, 8)
      .map(({ kind, path }) => ({ kind, path })),
  );
  const [resourcePixels, setResourcePixels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!active || !isNote) return;
    const targets: Array<{ kind: string; path: string }> = JSON.parse(resourceTargetsKey);
    let alive = true;
    void (async () => {
      const pixels: Record<string, string> = {};
      for (const target of targets) {
        try {
          const read = await client.read(target.path);
          if (!alive) return;
          if (read.savedContent === null) continue;
          pixels[target.path] =
            target.kind === "drawing"
              ? await drawingSvgForContent(read.savedContent, target.path)
              : await diagramSvgForWorkspace(read.savedContent, target.path, client);
        } catch {
          // A file that cannot be pictured shows as a placeholder in the note.
        }
        if (!alive) return;
      }
      if (alive) setResourcePixels(pixels);
    })();
    return () => {
      alive = false;
    };
  }, [active, client, isNote, resourceTargetsKey, snapshot.docId]);

  const handleSourceChange = useCallback(
    (text: string) => {
      if (frozen.current) return;
      if (text === store.snapshot().text) return;
      setPatchError(null);
      setSnapshot(store.setText(text));
    },
    [store],
  );

  const handleCursor = useCallback((line: number, column: number) => {
    setCursor({ line, column });
  }, []);

  const handlePatch = useCallback(
    (
      revision: number,
      patches: SourcePatch[],
      options?: RenderedPatchOptions,
    ) => {
      if (frozen.current) return false;
      try {
        if (!editorApi.current) throw new Error("Source editor is not ready.");
        const next = store.applyPatches(revision, patches);
        editorApi.current.applyExternalPatches(patches, options);
        setPatchError(null);
        setSnapshot(next);
        return true;
      } catch (error) {
        setPatchError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [store],
  );

  const handleHistory = useCallback((direction: "undo" | "redo") => {
    if (frozen.current) throw new Error("This session is waiting for move recovery.");
    if (!editorApi.current) throw new Error("Source editor is not ready.");
    return editorApi.current.history(direction);
  }, []);

  const handleRenderError = useCallback((message: string | null) => {
    setRenderError(message);
  }, []);

  const handleEditResource = useCallback(
    (path: string) => {
      void openPath(path);
    },
    [openPath],
  );

  // Notes compile-check in Source mode (same pipeline as Rendered).
  useEffect(() => {
    if (!isNote) {
      setSourceError(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void diagnoseSource(snapshot.text, snapshot.format).then((message) => {
        if (alive) setSourceError(message);
      });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [snapshot.text, snapshot.format, isNote]);

  const switchMode = useCallback((next: Mode) => {
    // Blurring the iframe can start an edit between pointerdown and click.
    // Keep that one click as an intent, but do not hide the editor mid-commit.
    if (renderedPendingRef.current) {
      pendingMode.current = next;
      setNotice('Finishing edit…');
      return;
    }
    pendingMode.current = null;
    setMode(next);
    if (next !== "source") setRenderedEver(true);
  }, []);

  const apple = useMemo(() => isApplePlatform(), []);
  const viewOptions = useMemo(
    () =>
      NOTE_VIEWS.map((option, index) => ({
        ...option,
        title: `${option.label} (${shortcutLabel(index + 1, apple)})`,
        keyShortcuts: ariaShortcut(index + 1, apple),
      })).filter((option) => !compact || option.value !== "split"),
    [apple, compact],
  );
  useEffect(() => {
    if (!active || !isNote) return;
    const onKey = (event: KeyboardEvent) => {
      const digit = viewShortcutDigit(event, apple);
      if (digit === null) return;
      const next = NOTE_VIEWS[digit - 1].value;
      if (!viewOptions.some((option) => option.value === next)) return;
      event.preventDefault();
      event.stopPropagation();
      switchMode(next);
    };
    // Capture, so a focused source editor cannot keep the keys for itself.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, apple, isNote, switchMode, viewOptions]);

  const doWrite = useCallback(
    async (target: string, expectedRevision: string | null, verb: string) => {
      if (frozen.current) return;
      if (renderedPendingRef.current) {
        setNotice("Finishing edit…");
        return;
      }
      if (savingRef.current) return;
      savingRef.current = true;
      // Capture the document identity with the text: completion below must
      // settle against THIS document, not whatever is open when the write
      // lands (the user may have opened a different file mid-save).
      const captured = {
        docId: store.snapshot().docId,
        path: target,
        text: store.snapshot().text,
      };
      setOpenFile((f) => markSaving(f));
      setNotice(null);
      try {
        const ok = await client.write(target, {
          content: captured.text,
          expectedRevision,
        });
        await refreshList();
        const completion = resolveSaveCompletion(captured, store.snapshot());
        if (completion.outcome === "saved-other-file") {
          // Another document is open now: report the save truthfully and
          // leave the current buffer (and its file row) exactly alone.
          setNotice(
            `${verb} ${ok.path}, then you moved on: the current file is untouched.`,
          );
          return;
        }
        if (completion.outcome === "saved-current") {
          setSnapshot(store.markSaved());
          setNotice(`${verb} ${ok.path}.`);
        } else {
          // The newer edits now compare against what was just saved.
          setSnapshot(store.markSaved(captured.text));
          setNotice(`${verb} ${ok.path}, but newer edits are still unsaved.`);
        }
        setOpenFile((f) => markSaved(f, ok.path, ok.revision));
      } catch (error) {
        if (store.snapshot().docId !== captured.docId) return;
        if (error instanceof LocalConflictError) {
          setOpenFile((f) =>
            markConflict(f, {
              currentRevision: error.currentRevision,
              currentContent: error.currentContent ?? "",
            }),
          );
          setNotice(
            `Save conflict: ${target} was saved elsewhere since you opened it. Load that version or overwrite it with yours.`,
          );
        } else {
          setOpenFile((f) => clearSave(f));
          setNotice(
            `Save failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        savingRef.current = false;
      }
    },
    [client, refreshList, store],
  );

  const doReload = useCallback(
    async (file: OpenFile) => {
      if (frozen.current) return;
      if (renderedPendingRef.current) {
        setNotice("Finishing edit…");
        return;
      }
      if (!file.path) return;
      if (
        store.snapshot().dirty &&
        !window.confirm(
          "Reload this file? Unsaved changes will be lost if you load the saved version.",
        )
      )
        return;
      setNotice(null);
      pendingOperation.current++;
      try {
        const read = await client.read(file.path);
        if (read.revision === null || read.savedContent === null) throw new Error("This file has no saved version yet.");
        const saved = read.savedContent;
        const { file: next, adopt } = applyReload(
          file,
          { revision: read.revision, content: saved },
          store.snapshot().dirty,
        );
        setOpenFile(next);
        if (adopt) {
          setComponentGeneration(value => value + 1);
          setSnapshot(
            store.replaceDocument(saved, formatForFilename(file.path)),
          );
          resetEditorMessages();
          setNotice(
            next.baseRevision === file.baseRevision
              ? "Already up to date."
              : "Reloaded the saved version.",
          );
        } else {
          setNotice(
            "A newer version was saved. Load it or keep editing yours.",
          );
        }
      } catch (error) {
        setNotice(
          `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        pendingOperation.current--;
      }
    },
    [client, resetEditorMessages, store],
  );

  const adoptServerText = useCallback(
    (content: string, revision: string, label: string) => {
      if (frozen.current) return;
      if (
        store.snapshot().dirty &&
        !window.confirm("Load the saved version and discard your unsaved changes?")
      )
        return;
      const target =
        openFile.path ?? openFile.pendingName ?? "notes/untitled.md";
      setSnapshot(store.replaceDocument(content, formatForFilename(target)));
      setOpenFile((f) => markSaved(f, target, revision));
      resetEditorMessages();
      setNotice(label);
    },
    [openFile.path, openFile.pendingName, resetEditorMessages, store],
  );

  // A newer saved copy (from another tab, or brought in by sync): a clean
  // buffer takes it; a buffer with edits keeps them and offers the choice.
  const checkingSaved = useRef(false);
  useEffect(() => {
    if (savedRevision === undefined || savedRevision === null || !openFile.path) return;
    if (savedRevision === openFile.baseRevision || openFile.save.stage === "saving" || savingRef.current) return;
    if (openFile.serverChanged?.currentRevision === savedRevision || checkingSaved.current) return;
    const path = openFile.path;
    checkingSaved.current = true;
    void client
      .read(path)
      .then((read) => {
        if (read.revision === null || read.savedContent === null) return;
        const current = store.snapshot();
        const { file: next, adopt } = applyReload(openFile, { revision: read.revision, content: read.savedContent }, current.dirty || renderedPendingRef.current);
        setOpenFile(next);
        if (adopt && read.savedContent !== current.text) {
          setComponentGeneration((value) => value + 1);
          setSnapshot(store.replaceDocument(read.savedContent, formatForFilename(path)));
        }
      })
      .catch(() => {
        // The next list refresh tries again.
      })
      .finally(() => {
        checkingSaved.current = false;
      });
  }, [client, openFile, savedRevision, store]);

  const handleExport = useCallback(async () => {
    if (renderedPendingRef.current) {
      setNotice("Finishing edit…");
      return;
    }
    const text = store.snapshot().text;
    setNotice(null);
    try {
      const outcome = await saveSourceText(displayName, text);
      if (outcome.status !== "cancelled") {
        setNotice(
          outcome.method === "file-picker"
            ? `Exported ${outcome.name}.`
            : `Downloaded ${outcome.name}.`,
        );
      }
    } catch (error) {
      setNotice(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [displayName, store]);

  const handleFormat = useCallback(async () => {
    if (frozen.current) return;
    pendingOperation.current++;
    setNotice(null);
    try {
      const changed = await editorApi.current?.formatSource();
      setNotice(changed ? "Formatted with Prettier." : "Already formatted.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pendingOperation.current--;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".monaco-editor")) return;
      event.preventDefault();
      const t = saveTarget(openFile);
      if (t)
        void doWrite(
          t,
          openFile.baseRevision,
          openFile.path ? "Saved" : "Created",
        );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, doWrite, openFile]);

  const inSource = view !== "rendered" || !isNote;
  const inRendered = isNote && view !== "source";
  const conflict = openFile.save.stage === "conflict" ? openFile.save : null;

  return (
    <div className="wb-session">
        <TablineActions active={active}>
        <div className="wb-view-toolbar" data-compact-toolbar={navigation ? "" : undefined}>
          <CompactFileIdentity navigation={navigation} path={displayName} />
          {isNote && (
            <ViewSwitcher
              ariaLabel="Editor mode"
              options={viewOptions}
              active={view}
              onSelect={switchMode}
            />
          )}
          {!navigation && <span className="wb-breadcrumb">{displayName}</span>}
          {/* Save shows only while there is something to save. */}
          {!readOnly && overallDirty && (
            <button
              type="button"
              className="wb-button wb-button-primary wb-save"
              aria-keyshortcuts="Meta+S Control+S"
              title="Save (Cmd+S)"
              disabled={renderedPending || !hasFile || openFile.save.stage === "saving"}
              onClick={() => {
                const t = saveTarget(openFile);
                if (t) void doWrite(t, openFile.baseRevision, openFile.path ? "Saved" : "Created");
              }}
            >
              Save
            </button>
          )}
          <ActionMenu>
            {!readOnly && <button
              disabled={
                renderedPending || !hasFile || openFile.save.stage === "saving"
              }
              onClick={() => {
                const t = saveTarget(openFile);
                if (t)
                  void doWrite(
                    t,
                    openFile.baseRevision,
                    openFile.path ? "Saved" : "Created",
                  );
              }}
            >
              <Save size={14} /> Save
            </button>}
            {onDuplicate && (
              <button onClick={onDuplicate}>
                <Copy size={14} /> Duplicate <MenuShortcut>{duplicateShortcutLabel()}</MenuShortcut>
              </button>
            )}
            {/* Read-only, the file follows its saved copy by itself. */}
            {!readOnly && <button
              disabled={renderedPending || !openFile.path}
              onClick={() => void doReload(openFile)}
            >
              <RefreshCw size={14} /> Reload
            </button>}
            <button
              disabled={renderedPending}
              onClick={() => void handleExport()}
            >
              <Download size={14} /> Export
            </button>
            {isNote && !readOnly && (
              <button
                disabled={renderedPending}
                onClick={() => void handleFormat()}
              >
                Format
              </button>
            )}
            {visibleRefs.map((ref) => (
              <button key={ref.path} onClick={() => openPath(ref.path)}>
                {ref.label} → {ref.path}
              </button>
            ))}
          </ActionMenu>
        </div>
        <div className="wb-session-status" aria-live="polite">
          <span>
            {renderedPending
              ? "Finishing edit…"
              : overallDirty
                ? "Unsaved changes"
                : "Saved"}
          </span>
          <span aria-label="cursor position">
            Ln {cursor.line}, Col {cursor.column}
          </span>
          {notice && <span>{notice}</span>}
        </div>
        </TablineActions>
      {renderError && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          Render error: {renderError} Source is unchanged and remains editable.
        </p>
      )}
      {inSource && isNote && sourceError && !renderError && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          Source check: {sourceError} Source is unchanged and remains editable.
        </p>
      )}
      {patchError && (
        <div
          role="alert"
          className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <span>Patch rejected: {patchError}</span>
          <button
            type="button"
            onClick={() => setPatchError(null)}
            className="min-h-10 shrink-0 rounded px-2 underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {conflict && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>
            Save conflict on {displayName}: it was saved elsewhere since you
            opened it. Your edits are intact; nothing was overwritten.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                adoptServerText(
                  conflict.currentContent,
                  conflict.currentRevision,
                  `Loaded the saved version of ${displayName}.`,
                )
              }
              className="inline-flex min-h-10 items-center rounded-lg border border-amber-400 bg-white px-3 font-medium dark:border-amber-700 dark:bg-neutral-900"
            >
              Load the saved version
            </button>
            <button
              type="button"
              onClick={() => {
                const t = saveTarget(openFile);
                if (t) void doWrite(t, conflict.currentRevision, "Overwrote");
              }}
              className="inline-flex min-h-10 items-center rounded-lg border border-amber-400 bg-white px-3 font-medium dark:border-amber-700 dark:bg-neutral-900"
            >
              Overwrite with my version
            </button>
            <button
              type="button"
              onClick={() => setOpenFile((f) => clearSave(f))}
              className="inline-flex min-h-10 items-center rounded-lg px-3 underline"
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      {openFile.serverChanged && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>
            {displayName} was changed elsewhere while you were editing. Your
            edits are intact.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                adoptServerText(
                  openFile.serverChanged?.currentContent ?? "",
                  openFile.serverChanged?.currentRevision ?? "",
                  `Loaded the saved version of ${displayName}.`,
                )
              }
              className="inline-flex min-h-10 items-center rounded-lg border border-amber-400 bg-white px-3 font-medium dark:border-amber-700 dark:bg-neutral-900"
            >
              Load the saved version
            </button>
            <button
              type="button"
              onClick={() =>
                setOpenFile((f) => ({ ...f, serverChanged: null }))
              }
              className="inline-flex min-h-10 items-center rounded-lg px-3 underline"
            >
              Keep editing mine
            </button>
          </div>
        </div>
      )}

      {conflicted && onResolveConflict && (
        <ConflictBanner
          name={displayName}
          path={openFile.path ?? initial.path}
          client={client}
          compareAs={{ kind: "text", language: editorLanguageForPath(openFile.path ?? initial.path) }}
          noun="file"
          hasUnsavedEdits={() => store.snapshot().dirty}
          onResolveConflict={onResolveConflict}
          onNotice={setNotice}
        />
      )}

        <div className="wb-editor-stage" data-view={isNote ? view : undefined}>
          <div hidden={!inSource} className="wb-source-stage">
            <SourceEditor
              initialText={initial.content}
              documentText={snapshot.text}
              format={snapshot.format}
              documentId={snapshot.docId}
              workspacePaths={workspacePaths}
              componentCatalog={componentState.environment?.catalog}
              editorLanguage={
                isNote ? undefined : editorLanguageForPath(displayName)
              }
              visible={active && inSource}
              renderError={renderError ?? sourceError}
              onChange={handleSourceChange}
              onCursor={handleCursor}
              readOnly={readOnly}
              onSave={() => {
                if (readOnly) {
                  setNotice(readOnly);
                  return;
                }
                const t = saveTarget(openFile);
                if (t)
                  void doWrite(
                    t,
                    openFile.baseRevision,
                    openFile.path ? "Saved" : "Created",
                  );
              }}
              apiRef={editorApi}
            />
          </div>
          {isNote && renderedEver && (
            <div hidden={!inRendered} className="wb-rendered-stage">
              <RenderedEditor
                document={snapshot}
                active={active && inRendered}
                documentId={snapshot.docId}
                componentEnvironment={componentState.environment}
                componentError={componentState.error}
                componentPending={componentState.pending}
                onHistory={handleHistory}
                onPendingChange={handleRenderedPending}
                onPatch={handlePatch}
                onError={handleRenderError}
                resources={resourcePixels}
                allowedResourcePaths={refs.map((ref) => ref.path)}
                availableResourcePaths={workspacePaths.filter((path) =>
                  /\.(?:excalidraw(?:\.md)?|d2)$/.test(path),
                )}
                onEditResource={handleEditResource}
                readOnly={Boolean(readOnly)}
              />
            </div>
          )}
        </div>
    </div>
  );
}
