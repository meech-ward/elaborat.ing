import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OperationSession } from "./operationSession";
import { Banner, BannerAction, EDITOR_VIEWS, SplitPanes, commandShortcut, isApplePlatform, type EditorView, type MenuEntry } from "@/features/design-system";
import { FileHeader } from "./FileHeader";
import { useCompactWorkbench } from "./compactWorkbench";
import type { TabFile } from "./tabs";
import { SourceEditor, type SourceEditorApi } from "@/features/source";
import type { RenderedEditorApi } from "@/features/rendered";
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
import { useCanvasPresentation } from "./viewTheme";
import { readProjectView, writeProjectView } from "./projectViews";
import { viewShortcutDigit } from "./viewShortcuts";
import { useComponentEnvironment } from '../document/useComponentEnvironment';
import { useNoteComments, type NoteCommentRequest } from "@/features/comments";
import { savedComponentSource } from '../document/componentModules';
import { CustomCodeNotice, useCustomCodeGate, useCustomCodePolicy } from "@/features/custom-code";
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

type Mode = EditorView;

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
  server = null,
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
  /** The server's id and version for the file (comments hang off the id), or null before it is on the server. */
  server?: { id: string; version: number } | null;
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
  // Split is desktop only: at compact widths a stored Split shows Rendered.
  const compact = useCompactWorkbench();
  const [mode, setMode] = useState<Mode>(() => {
    const stored = readProjectView(client.persistenceKey, initial.path);
    if (stored === "rendered" || stored === "split" || stored === "source") return stored;
    // A note not opened before reads rendered on a phone, and opens its source on a desktop.
    return compact && kindForPath(initial.path) === "note" ? "rendered" : "source";
  });
  const view: Mode = mode === "split" && compact ? "rendered" : mode;
  const [renderedEver, setRenderedEver] = useState(mode !== "source");
  useEffect(() => { writeProjectView(client.persistenceKey, initial.path, mode); }, [client.persistenceKey, initial.path, mode]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [componentGeneration, setComponentGeneration] = useState(0);
  const loadComponentSource = useCallback(async (path: string) => {
    const file = await client.read(path);
    return savedComponentSource({ ...file, revision: file.revision ?? "" });
  }, [client]);
  // A module saved in another tab, or brought in by sync, rebuilds the components.
  const subscribeToStore = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const componentState = useComponentEnvironment(snapshot.text, snapshot.format === 'mdx', loadComponentSource, componentGeneration, subscribeToStore);
  // In a project shared with the person, custom components run only once they choose to.
  const customCode = useCustomCodePolicy();
  const componentGate = useCustomCodeGate(customCode, openFile.path ?? initial.path, componentState, snapshot.dirty);
  const shownComponents = componentGate.kind === "open" ? componentGate.components : null;
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
  // A diagram shows in the palette's diagram fills, as on its canvas (the
  // note frame's dark filter turns them into the dark ones).
  const presentDiagram = useCanvasPresentation("diagram");
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
              : await diagramSvgForWorkspace(read.savedContent, target.path, client, presentDiagram);
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
  }, [active, client, isNote, presentDiagram, resourceTargetsKey, snapshot.docId]);

  const handleSourceChange = useCallback(
    (text: string) => {
      if (frozen.current) return;
      if (text === store.snapshot().text) return;
      setPatchError(null);
      setSnapshot(store.setText(text));
    },
    [store],
  );

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

  // A note that asks again (a component file changed) stops its rendered
  // view, so an edit it had under way is let go.
  const asking = componentGate.kind === "ask";
  useEffect(() => {
    if (asking) handleRenderedPending(false);
  }, [asking, handleRenderedPending]);

  const apple = useMemo(() => isApplePlatform(), []);

  // The note's comments: the panel's file while it is on screen, and the
  // commented text both views mark. The panel shows a thread's text in the
  // views on screen; the source takes the keyboard, or the note on its own.
  const renderedApi = useRef<RenderedEditorApi | null>(null);
  const noteComments = useNoteComments({
    path: initial.path,
    server,
    active,
    text: snapshot.text,
    onReveal: (mark, focus) => {
      const sourceShown = view !== "rendered" || !isNote;
      if (sourceShown) editorApi.current?.revealRange(mark.from, mark.to, focus);
      if (isNote && view !== "source") renderedApi.current?.revealRange(mark.from, mark.to, focus && !sourceShown);
    },
  });
  const commentProps = {
    marks: noteComments.marks,
    source: noteComments.marksSource,
    canComment: noteComments.canComment,
    offline: noteComments.offline,
    shortcut: apple ? { label: "⌘⌥M", aria: "Meta+Alt+M" } : { label: "Ctrl+Alt+M", aria: "Control+Alt+M" },
    onOpen: noteComments.open,
    onComment: (request: NoteCommentRequest, source: string) => {
      const problem = noteComments.comment(request, source);
      if (problem) setNotice(problem);
    },
  };
  // A phone has no room to split.
  const views = useMemo<EditorView[]>(() => (compact ? ["source", "rendered"] : ["source", "split", "rendered"]), [compact]);
  useEffect(() => {
    if (!active || !isNote) return;
    const onKey = (event: KeyboardEvent) => {
      const digit = viewShortcutDigit(event, apple);
      if (digit === null) return;
      const next = EDITOR_VIEWS[digit - 1].value;
      if (!views.includes(next)) return;
      event.preventDefault();
      event.stopPropagation();
      switchMode(next);
    };
    // Capture, so a focused source editor cannot keep the keys for itself.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, apple, isNote, switchMode, views]);

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

  const save = () => {
    const t = saveTarget(openFile);
    if (t) void doWrite(t, openFile.baseRevision, openFile.path ? "Saved" : "Created");
  };
  const saveDisabled = renderedPending || !hasFile || openFile.save.stage === "saving";
  const duplicateKey = commandShortcut("D", apple);
  // The file's actions: its tab's menu on a desktop, "..." on a phone.
  const fileActions: MenuEntry[] = [
    ...(readOnly ? [] : [{ label: "Save", disabled: saveDisabled, onSelect: save }]),
    ...(onDuplicate ? [{ label: "Duplicate", shortcut: duplicateKey.label, keyShortcuts: duplicateKey.aria, onSelect: onDuplicate }] : []),
    // Read-only, the file follows its saved copy by itself.
    ...(readOnly ? [] : [{ label: "Reload", disabled: renderedPending || !openFile.path, onSelect: () => void doReload(openFile) }]),
    { label: "Export", disabled: renderedPending, onSelect: () => void handleExport() },
    ...(isNote && !readOnly ? [{ label: "Format", disabled: renderedPending, onSelect: () => void handleFormat() }] : []),
    ...visibleRefs.map((ref) => ({ label: `${ref.label} → ${ref.path}`, onSelect: () => openPath(ref.path) })),
  ];

  return (
    <div className="wb-session">
      <FileHeader
        path={initial.path}
        active={active}
        navigation={navigation}
        view={isNote ? { value: view, views, names: "note", label: "Editor mode", onChange: switchMode } : undefined}
        save={!readOnly && overallDirty ? { disabled: saveDisabled, onSave: save } : null}
        actions={fileActions}
      />
      {/* The saved state and the last notice, for screen readers: Save and
          the tab's unsaved dot show it on screen. */}
      {active && (
        <div className="sr-only" aria-live="polite">
          <span>{renderedPending ? "Finishing edit…" : overallDirty ? "Unsaved changes" : "Saved"}</span>
          {notice && <span>{notice}</span>}
        </div>
      )}
      {renderError && (
        <Banner tone="danger" className="mt-2">
          Render error: {renderError} Source is unchanged and remains editable.
        </Banner>
      )}
      {inSource && isNote && sourceError && !renderError && (
        <Banner tone="danger" className="mt-2">
          Source check: {sourceError} Source is unchanged and remains editable.
        </Banner>
      )}
      {patchError && (
        <Banner
          role="alert"
          className="mt-2"
          action={<BannerAction onClick={() => setPatchError(null)}>Dismiss</BannerAction>}
        >
          Patch rejected: {patchError}
        </Banner>
      )}
      {conflict && (
        <Banner
          role="alert"
          className="mt-2"
          action={
            <span className="inline-flex flex-wrap gap-x-3">
              <BannerAction
                onClick={() =>
                  adoptServerText(
                    conflict.currentContent,
                    conflict.currentRevision,
                    `Loaded the saved version of ${displayName}.`,
                  )
                }
              >
                Load the saved version
              </BannerAction>
              <BannerAction
                onClick={() => {
                  const t = saveTarget(openFile);
                  if (t) void doWrite(t, conflict.currentRevision, "Overwrote");
                }}
              >
                Overwrite with my version
              </BannerAction>
              <BannerAction onClick={() => setOpenFile((f) => clearSave(f))}>Keep editing</BannerAction>
            </span>
          }
        >
          Save conflict on {displayName}: it was saved elsewhere since you
          opened it. Your edits are intact; nothing was overwritten.
        </Banner>
      )}
      {openFile.serverChanged && (
        <Banner
          role="alert"
          className="mt-2"
          action={
            <span className="inline-flex flex-wrap gap-x-3">
              <BannerAction
                onClick={() =>
                  adoptServerText(
                    openFile.serverChanged?.currentContent ?? "",
                    openFile.serverChanged?.currentRevision ?? "",
                    `Loaded the saved version of ${displayName}.`,
                  )
                }
              >
                Load the saved version
              </BannerAction>
              <BannerAction onClick={() => setOpenFile((f) => ({ ...f, serverChanged: null }))}>Keep editing mine</BannerAction>
            </span>
          }
        >
          {displayName} was changed elsewhere while you were editing. Your
          edits are intact.
        </Banner>
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

        {/* Source, Split or Rendered: both panes stay mounted, so the editor
        and the note keep their state when the view changes. */}
        <SplitPanes
          className="min-h-0 flex-1"
          show={!inRendered ? "start" : !inSource ? "end" : "both"}
          startSize="46.45%"
          aria-label="Resize the source and the rendered note"
          start={
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
              onCursor={() => {}}
              readOnly={readOnly}
              comments={{ ...commentProps, sections: isNote }}
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
          }
          end={isNote && renderedEver && (
            <div hidden={!inRendered} className="wb-rendered-stage">
              {componentGate.kind === "ask" ? (
                <CustomCodeNotice files={componentGate.files} onRun={componentGate.run} onShowSource={() => switchMode("source")} />
              ) : (
              <RenderedEditor
                document={snapshot}
                active={active && inRendered}
                documentId={snapshot.docId}
                componentEnvironment={shownComponents?.environment}
                componentError={shownComponents?.error}
                componentPending={shownComponents?.pending}
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
                comments={commentProps}
                apiRef={renderedApi}
              />
              )}
            </div>
          )}
        />
    </div>
  );
}
