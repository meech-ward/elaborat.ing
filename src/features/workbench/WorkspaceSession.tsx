import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OperationSession } from "./operationSession";
import { Banner, BannerAction, EDITOR_VIEWS, SplitPanes, commandShortcut, confirmAction, isApplePlatform, type EditorView, type MenuEntry } from "@/features/design-system";
import { FileHeader } from "./FileHeader";
import { useCompactWorkbench } from "./compactWorkbench";
import { embedded, openInNewTab } from "@/features/embed/mode";
import { ARRIVAL_WAIT_MS, ARRIVING_REVISION, type TabFile } from "./tabs";
import { SourceEditor, preloadSourceEditor, type SourceEditorApi } from "@/features/source";
import type { ImageChoice } from "../images/ImagePicker";
import { LazyImagePicker } from "../images/LazyImages";
import type { ImagePreview } from "../images/transport";
import type { RenderedEditorApi } from "@/features/rendered";
import type { SourcePatch } from "@/features/document";
import type { WriteIn } from "@/features/document/writeIn";
import { LazyRenderedEditor, preloadRenderedEditor } from "./LazyRenderedEditor";
import type { NotePlace, RenderedPatchOptions } from "../source/renderedHistory";
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
import { savedComponentSource } from '../document/componentSource';
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
import { linkedFile, resolveNoteLink } from "./noteLinks";
import { useSettledError, useTyping } from "@/lib/settledError";

type Mode = EditorView;

/** Each view's code loads when it first shows; the pointer on the view switch starts both. */
function preloadViews() {
  preloadSourceEditor();
  preloadRenderedEditor();
}

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
  onActivity,
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
  /** The person used the rendered note's frame (a key, a press, the wheel), which the page cannot see itself. */
  onActivity?: () => void;
}) {
  // A note opened to follow an agent starts empty (TabFile.arriving), and
  // takes its saved version once its views show that (below).
  const [opening] = useState<TabFile>(() =>
    initial.arriving ? { path: initial.path, content: "", revision: ARRIVING_REVISION, savedContent: "" } : initial,
  );
  const [store] = useState(() => {
    const store = createDocumentStore(
      opening.savedContent !== undefined ? opening.savedContent ?? "" : opening.revision ? opening.content : "",
      formatForFilename(initial.path),
    );
    if ((!opening.revision && opening.content) || opening.savedContent !== undefined) store.setText(opening.content);
    return store;
  });
  const [snapshot, setSnapshot] = useState<StoreState>(() => store.snapshot());
  const [openFile, setOpenFile] = useState<OpenFile>(() =>
    opening.revision
      ? openWorkspaceFile(initial.path, opening.revision)
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
  // Each error with the text it was found in, as the checks run after the text changes.
  const [renderError, setRenderError] = useState<{ text: string; message: string } | null>(null);
  const [sourceError, setSourceError] = useState<{ text: string; message: string } | null>(null);
  // The person's own edits in the source: while they type, an error in the
  // half-typed text waits until they pause, or until they act on the text (a
  // view switch, Save, Export, Format) and it shows at once (lib/settledError.ts).
  const { typing, typed, settle } = useTyping();
  const shownRenderError = useSettledError(renderError?.message ?? null, typing, renderError?.text === snapshot.text);
  const shownSourceError = useSettledError(sourceError?.message ?? null, typing, sourceError?.text === snapshot.text);
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
  const [imageRequest, setImageRequest] = useState<{ files?: readonly File[]; initialAlt?: string; commit: (images: readonly { path: string; alt: string }[]) => Promise<boolean> } | null>(null);
  const requestedImageFiles = useMemo(() => imageRequest?.files ? [...imageRequest.files] : undefined, [imageRequest]);
  const [imageEntries, setImageEntries] = useState<Awaited<ReturnType<WorkspaceStore["listEntries"]>>["files"]>([]);
  const [imageResources, setImageResources] = useState<Record<string, ImagePreview>>({});
  const [imageGeneration, setImageGeneration] = useState(0);
  useEffect(() => client.subscribe(() => setImageGeneration(value => value + 1)), [client]);
  useEffect(() => {
    if (!imageRequest) return;
    let live = true;
    void client.listEntries().then(entries => { if (live) setImageEntries(entries.files.filter(file => file.kind === "image")); });
    return () => { live = false; };
  }, [client, imageRequest, imageGeneration]);
  const imageModuleSources = JSON.stringify(shownComponents?.environment?.code.filter(module => module.path !== null) ?? []);
  useEffect(() => {
    if (!active || !client.readImage || kindForPath(initial.path) !== "note") return;
    let live = true;
    void (async () => {
      const [{ parseImageReferences }, { imageDataURL }] = await Promise.all([import("../images/references"), import("../images/types")]);
      const refs = await parseImageReferences(snapshot.text, snapshot.format, initial.path, JSON.parse(imageModuleSources));
      const pixels: Record<string, ImagePreview> = {};
      let total = 0;
      for (const ref of refs) {
        if (!live) return;
        try {
          const file = await client.read(ref.path);
          if (file.kind !== "image" || !file.asset || pixels[ref.key]) continue;
          const blob = await client.readImage!(ref.path, true);
          total += blob.size;
          if (total > 20 * 1024 * 1024) break;
          pixels[ref.key] = { dataURL: imageDataURL(new Uint8Array(await blob.arrayBuffer()), file.asset.preview_type), width: file.asset.width, height: file.asset.height };
        } catch { /* Missing or incomplete images show the frame's placeholder. */ }
      }
      if (live) setImageResources(pixels);
    })().catch(() => { if (live) setImageResources({}); });
    return () => { live = false; };
  }, [active, client, initial.path, snapshot.text, snapshot.format, imageModuleSources, imageGeneration]);
  const readImageOriginal = useCallback(async (key: string): Promise<ImagePreview> => {
    if (!client.readImage) throw new Error("Image viewing is unavailable.");
    const [{ parseImageReferences }, { imageDataURL }] = await Promise.all([import("../images/references"), import("../images/types")]);
    const refs = await parseImageReferences(store.snapshot().text, store.snapshot().format, initial.path, JSON.parse(imageModuleSources));
    const ref = refs.find(ref => ref.key === key);
    if (!ref) throw new Error("This image is no longer in the document.");
    const file = await client.read(ref.path);
    if (file.kind !== "image" || !file.asset) throw new Error("The image is unavailable.");
    const blob = await client.readImage(ref.path);
    return { dataURL: imageDataURL(new Uint8Array(await blob.arrayBuffer()), file.asset.media_type), width: file.asset.width, height: file.asset.height };
  }, [client, initial.path, imageModuleSources, store]);
  const chooseImages = async (choices: ImageChoice[]) => {
    if (!imageRequest || readOnly || frozen.current || !client.stageImage) throw new Error("This document cannot be changed right now.");
    const { imageExtension } = await import("../images/types");
    const entries = await client.listEntries();
    const taken = new Set(entries.files.map(file => file.path));
    const staged: string[] = [];
    let committed = false;
    const selected: { path: string; alt: string; caption?: string }[] = [];
    try {
      for (const choice of choices) {
        if (choice.prepared) {
          const image = choice.prepared;
          const stem = image.name.normalize("NFC").replace(/\.[^.]+$/, "").replace(/[\\/:\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").slice(0, 100) || "image";
          const extension = imageExtension(image.asset.media_type);
          let path = `images/${stem}.${extension}`, number = 2;
          while (taken.has(path)) path = `images/${stem}-${number++}.${extension}`;
          taken.add(path);
          let originalPath = image.originalPath;
          if (image.original && !originalPath) {
            const original = image.original;
            const originalStem = original.name.normalize("NFC").replace(/\.[^.]+$/, "").replace(/[\\/:\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").slice(0, 100) || "original";
            const originalExtension = imageExtension(original.asset.media_type);
            originalPath = `images/${originalStem}.${originalExtension}`;
            let number = 2;
            while (taken.has(originalPath)) originalPath = `images/${originalStem}-original-${number++}.${originalExtension}`;
            taken.add(originalPath);
            await client.stageImage(originalPath, original.bytes, { ...original.asset, draft_note: initial.path }, [], original.preview);
            staged.push(originalPath);
          }
          await client.stageImage(path, image.bytes, { ...image.asset, draft_note: initial.path, ...(originalPath ? { original_path: originalPath } : {}) }, [], image.preview);
          staged.push(path);
          selected.push({ path, alt: choice.alt, ...(choice.caption ? { caption: choice.caption } : {}) });
        } else if (choice.existingPath) {
          const file = await client.read(choice.existingPath);
          if (file.kind !== "image" || !file.asset) throw new Error("Choose an image from this project.");
          selected.push({ path: choice.existingPath, alt: choice.alt, ...(choice.caption ? { caption: choice.caption } : {}) });
        }
      }
      if (!selected.length || !await imageRequest.commit(selected)) throw new Error("The document changed while choosing images. Insert them again at the new position.");
      committed = true;
      await client.persistDrafts([{ path: initial.path, content: store.snapshot().text, baseRevision: openFile.baseRevision }]);
      await refreshList();
    } catch (error) {
      // A rejected insertion never leaves new image files in the explorer.
      if (!committed) for (const path of staged) await client.discardLocalDraft(path);
      throw error;
    }
  };

  // Text that is not an edit is never kept as a draft: an arriving note's
  // empty start, or a clean saved copy while a newer one waits to be taken
  // (below; in a chat's panel, while the note is not on screen). As a draft
  // it would undo that newer copy.
  const notAnEdit = useCallback(
    (dirty: boolean) => openFile.baseRevision === ARRIVING_REVISION || (!dirty && savedRevision != null && savedRevision !== openFile.baseRevision),
    [openFile.baseRevision, savedRevision],
  );
  useEffect(() => {
    if (readOnly || notAnEdit(snapshot.dirty)) return;
    let alive = true;
    void client.persistDrafts([{ path: initial.path, content: snapshot.text, baseRevision: openFile.baseRevision }]).catch((error: unknown) => {
      if (alive) setNotice(`Local draft could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { alive = false; };
  }, [client, initial.path, notAnEdit, openFile.baseRevision, readOnly, snapshot.dirty, snapshot.text]);
  const editorApi = useRef<SourceEditorApi | null>(null);
  const renderedApi = useRef<RenderedEditorApi | null>(null);
  const [renderedPending, setRenderedPending] = useState(false);
  const renderedPendingRef = useRef(false);
  // Whatever waits for a rendered edit to finish (a duplicate), let go once it has.
  const editWaiters = useRef<Array<() => void>>([]);
  const pendingMode = useRef<Mode | null>(null);
  // Switching between Source and Rendered keeps the person's place: the view
  // shown takes the caret or selection from the other, or the text at its top
  // (NotePlace). Source shows once Rendered has said where it is; Rendered
  // shows Source's place once it has the note's current text.
  const [renderedPlace, setRenderedPlace] = useState<NotePlace | null>(null);
  const renderedPlaceShown = useCallback(() => setRenderedPlace(null), []);
  const sourcePlace = useRef<NotePlace | null>(null);
  const shownView = useRef(view);
  useLayoutEffect(() => {
    shownView.current = view;
  }, [view]);
  const placeAsked = useRef(0);
  const showMode = useCallback((next: Mode) => {
    const asked = ++placeAsked.current;
    const from = shownView.current;
    setRenderedPlace(from === "source" && next === "rendered" ? (editorApi.current?.place() ?? null) : null);
    const show = (place: NotePlace | null) => {
      sourcePlace.current = place;
      setMode(next);
      if (next !== "source") setRenderedEver(true);
    };
    const rendered = renderedApi.current;
    if (from !== "rendered" || next !== "source" || !rendered) {
      show(null);
      return;
    }
    void rendered.place().then((place) => {
      if (asked !== placeAsked.current) return;
      // An edit begun meanwhile finishes first; the switch asks again then.
      if (renderedPendingRef.current) {
        pendingMode.current = next;
        setNotice("Finishing edit…");
        return;
      }
      show(place);
    });
  }, []);
  // Source takes the place from Rendered once it shows.
  useEffect(() => {
    const place = sourcePlace.current;
    sourcePlace.current = null;
    if (place && view === "source") editorApi.current?.showPlace(place);
  }, [view]);
  const handleRenderedPending = useCallback((pending: boolean) => {
    renderedPendingRef.current = pending;
    setRenderedPending(pending);
    if (!pending) for (const resolve of editWaiters.current.splice(0)) resolve();
    if (!pending && pendingMode.current !== null) {
      const next = pendingMode.current;
      pendingMode.current = null;
      showMode(next);
      setNotice(current => current === 'Finishing edit…' ? null : current);
    }
  }, [showMode]);
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
        if (readOnly || notAnEdit(store.snapshot().dirty)) return;
        await client.persistDrafts([{ path: initial.path, content: store.snapshot().text, baseRevision: openFile.baseRevision }]);
      },
      whenEditFinished: () =>
        renderedPendingRef.current ? new Promise<void>((resolve) => { editWaiters.current.push(resolve); }) : Promise.resolve(),
    });
    return () => onOperationSession?.(initial.path,null);
  }, [client,initial.path,locked,notAnEdit,onOperationSession,openFile,readOnly,store]);

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
      // Text that arrived (a rendered edit, an agent's save, a reload) is in the store already.
      if (text === store.snapshot().text) return;
      typed();
      setPatchError(null);
      setSnapshot(store.setText(text));
    },
    [store, typed],
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
    setRenderError(message === null ? null : { text: store.snapshot().text, message });
  }, [store]);

  const handleEditResource = useCallback(
    (path: string) => {
      void openPath(path);
    },
    [openPath],
  );

  // A link clicked in the rendered note: a project file opens in a tab, a web
  // page in a new browser tab, which in a chat's panel the chat opens.
  const handleOpenLink = useCallback(
    (href: string) => {
      const link = resolveNoteLink(href, initial.path);
      if (link.kind === "web") {
        if (embedded) openInNewTab(link.url);
        else window.open(link.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (link.kind !== "file") return;
      const file = linkedFile(link.path, workspacePaths);
      if (file) openPath(file);
      else setNotice(`There's no ${link.path} in this project.`);
    },
    [initial.path, workspacePaths, openPath],
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
        if (alive) setSourceError(message === null ? null : { text: snapshot.text, message });
      });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [snapshot.text, snapshot.format, isNote]);

  const switchMode = useCallback((next: Mode) => {
    settle();
    // Blurring the iframe can start an edit between pointerdown and click.
    // Keep that one click as an intent, but do not hide the editor mid-commit.
    if (renderedPendingRef.current) {
      pendingMode.current = next;
      setNotice('Finishing edit…');
      return;
    }
    pendingMode.current = null;
    showMode(next);
  }, [settle, showMode]);

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
    attaching: noteComments.attaching,
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

  // A save asked for while a rendered edit finishes, run once it has (as a view switch is).
  const pendingWrite = useRef<{ target: string; expectedRevision: string | null; verb: string } | null>(null);
  const doWrite = useCallback(
    async (target: string, expectedRevision: string | null, verb: string) => {
      settle();
      if (frozen.current) return;
      if (renderedPendingRef.current) {
        pendingWrite.current = { target, expectedRevision, verb };
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
        const imagePaths: string[] = [];
        const pendingImages: string[] = [];
        if (kindForPath(target) === "note" && client.saveImages) {
          try {
            const { parseImageReferences } = await import("../images/references");
            const refs = await parseImageReferences(captured.text, store.snapshot().format, target);
            pendingImages.push(...new Set(refs.map(ref => ref.path)));
          } catch {
            // Source can be saved while incomplete. Its own durable image
            // drafts still travel with it, without treating broken syntax as authority.
            const entries = await client.listEntries();
            pendingImages.push(...entries.files.filter(file => file.draft && file.asset?.draft_note === target).map(file => file.path));
          }
        }
        const visitedImages = new Set<string>();
        for (let index = 0; index < pendingImages.length; index++) {
          const path = pendingImages[index];
          if (visitedImages.has(path)) continue;
          visitedImages.add(path);
          const asset = await client.draftImageAsset?.(path);
          if (asset) { imagePaths.push(path); if (asset.original_path) pendingImages.push(asset.original_path); }
        }
        const ok = client.saveImages && imagePaths.length
          ? (await client.saveImages(imagePaths, [{ path: target, content: captured.text, expectedRevision }])).find(file => file.path === target)!
          : await client.write(target, { content: captured.text, expectedRevision });
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
    [client, refreshList, settle, store],
  );
  useEffect(() => {
    const write = pendingWrite.current;
    if (renderedPending || !write) return;
    pendingWrite.current = null;
    void doWrite(write.target, write.expectedRevision, write.verb);
  }, [doWrite, renderedPending]);

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
        !(await confirmAction(
          "Reload this file? Unsaved changes will be lost if you load the saved version.",
          { confirmLabel: "Reload" },
        ))
      )
        return;
      if (frozen.current) return;
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
    async (content: string, revision: string, label: string) => {
      if (frozen.current) return;
      if (
        store.snapshot().dirty &&
        !(await confirmAction("Load the saved version and discard your unsaved changes?", { confirmLabel: "Load it" }))
      )
        return;
      if (frozen.current) return;
      const target =
        openFile.path ?? openFile.pendingName ?? "notes/untitled.md";
      setSnapshot(store.replaceDocument(content, formatForFilename(target)));
      setOpenFile((f) => markSaved(f, target, revision));
      resetEditorMessages();
      setNotice(label);
    },
    [openFile.path, openFile.pendingName, resetEditorMessages, store],
  );

  // In a chat's panel a note takes a newer saved version (an agent's, say)
  // only while it is on screen and each view there has shown the text it
  // holds, so the views write in what that version added: a note behind
  // another tab takes it when it comes forward, and one opened to follow an
  // agent (TabFile.arriving) once its views have shown it empty (the editors
  // load on first use). A view not shown ARRIVAL_WAIT_MS after the note came
  // on screen is not waited for.
  const [shownViews, setShownViews] = useState({ source: false, rendered: false, waited: false });
  const viewsShown =
    (shownViews.source || (isNote && view === "rendered")) && (shownViews.rendered || !isNote || view === "source");
  useEffect(() => {
    if (!embedded || !active || viewsShown) return;
    const timer = window.setTimeout(() => setShownViews((shown) => ({ ...shown, waited: true })), ARRIVAL_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [active, viewsShown]);
  const sourceShown = useCallback(() => setShownViews((shown) => (shown.source ? shown : { ...shown, source: true })), []);
  const renderedShown = useCallback(() => setShownViews((shown) => (shown.rendered ? shown : { ...shown, rendered: true })), []);
  const holdBack = embedded && (!active || (!viewsShown && !shownViews.waited));

  // A newer saved copy (from another tab, or brought in by sync): a clean
  // buffer takes it; a buffer with edits keeps them and offers the choice.
  // The copy the note last took this way (an agent's section, say), with the
  // text it showed before: the views write in what it added.
  const [arrived, setArrived] = useState<WriteIn | null>(null);
  const checkingSaved = useRef(false);
  useEffect(() => {
    if (savedRevision === undefined || savedRevision === null || !openFile.path || holdBack) return;
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
          const taken = store.replaceDocument(read.savedContent, formatForFilename(path));
          setArrived({ documentId: taken.docId, text: taken.text, before: current.text });
          setSnapshot(taken);
        }
      })
      .catch(() => {
        // The next list refresh tries again.
      })
      .finally(() => {
        checkingSaved.current = false;
      });
  }, [client, holdBack, openFile, savedRevision, store]);

  const handleExport = useCallback(async () => {
    settle();
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
  }, [displayName, settle, store]);

  const handleFormat = useCallback(async () => {
    settle();
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
  }, [settle]);

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
  // The header's Save stays on while a rendered edit finishes, so it doesn't
  // blink at each keystroke; a save pressed then waits for the edit (doWrite).
  const headerSaveDisabled = !hasFile || openFile.save.stage === "saving";
  const duplicateKey = commandShortcut("D", apple);
  // The file's actions: its tab's menu on a desktop, "..." on a phone.
  const fileActions: MenuEntry[] = [
    ...(readOnly ? [] : [{ label: "Save", disabled: saveDisabled, onSelect: save }]),
    // Off while a rendered edit is finishing, as Save is, so the copy has it.
    ...(onDuplicate ? [{ label: "Duplicate", shortcut: duplicateKey.label, keyShortcuts: duplicateKey.aria, disabled: renderedPending, onSelect: onDuplicate }] : []),
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
        view={isNote ? { value: view, views, names: "note", label: "Editor mode", onChange: switchMode, preload: preloadViews } : undefined}
        save={!readOnly && overallDirty ? { disabled: headerSaveDisabled, onSave: save } : null}
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
      {/* The note's error, in every view. The rendered view reports its errors
          here instead of in a banner of its own (errorBanner), so each shows once. */}
      {shownRenderError && (
        <Banner tone="danger" className="mt-2">
          Render error: {shownRenderError} Source is unchanged and remains editable.
        </Banner>
      )}
      {inSource && isNote && shownSourceError && !shownRenderError && (
        <Banner tone="danger" className="mt-2">
          Source check: {shownSourceError} Source is unchanged and remains editable.
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
                  void adoptServerText(
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
                  void adoptServerText(
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
              initialText={opening.content}
              documentText={snapshot.text}
              format={snapshot.format}
              documentId={snapshot.docId}
              workspacePaths={workspacePaths}
              componentCatalog={componentState.environment?.catalog}
              editorLanguage={
                isNote ? undefined : editorLanguageForPath(displayName)
              }
              visible={active && inSource}
              renderError={shownRenderError ?? shownSourceError}
              onChange={handleSourceChange}
              onCursor={() => {}}
              readOnly={readOnly}
              comments={{ ...commentProps, sections: isNote }}
              writeIn={isNote ? arrived : null}
              onShown={embedded ? sourceShown : undefined}
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
              <LazyRenderedEditor
                document={snapshot}
                active={active && inRendered}
                documentId={snapshot.docId}
                documentPath={initial.path}
                imageResources={imageResources}
                onReadImage={readImageOriginal}
                onInsertImage={!readOnly && client.stageImage && client.projectId ? setImageRequest : undefined}
                componentEnvironment={shownComponents?.environment}
                componentError={shownComponents?.error}
                componentPending={shownComponents?.pending}
                onHistory={handleHistory}
                onPendingChange={handleRenderedPending}
                onPatch={handlePatch}
                onError={handleRenderError}
                // Its errors show in the Render error banner above the views.
                errorBanner={false}
                typing={typing}
                resources={resourcePixels}
                allowedResourcePaths={refs.map((ref) => ref.path)}
                availableResourcePaths={workspacePaths.filter((path) =>
                  /\.(?:excalidraw(?:\.md)?|d2)$/.test(path),
                )}
                onEditResource={handleEditResource}
                onOpenLink={handleOpenLink}
                readOnly={Boolean(readOnly)}
                comments={commentProps}
                writeIn={arrived}
                onShown={embedded ? renderedShown : undefined}
                onActivity={onActivity}
                place={renderedPlace}
                onPlaceShown={renderedPlaceShown}
                apiRef={renderedApi}
              />
              )}
            </div>
          )}
        />
      {client.projectId && <LazyImagePicker open={Boolean(imageRequest)} onOpenChange={open => { if (!open) setImageRequest(null); }}
        projectId={client.projectId} initialAlt={imageRequest?.initialAlt} images={imageEntries} files={requestedImageFiles}
        readImage={client.readImage} onDescribe={import.meta.env.VITE_CHATGPT_PLAN ? async (choice, signal) => {
          const preview = choice.prepared?.preview ?? (choice.existingPath && client.readImage ? await client.readImage(choice.existingPath, true) : null);
          if (!preview) throw new Error("Choose an image first.");
          const { describeImage } = await import("../images/describe");
          return describeImage(preview, signal);
        } : undefined} onChoose={choice => chooseImages([choice])} onChooseMany={chooseImages}
        importFromURL={client.persistenceKey.startsWith('["local"') ? undefined : async (url, signal) => {
          const { importProjectImageURL } = await import("../images/importURL");
          return importProjectImageURL(client.projectId!, url, signal);
        }} />}
    </div>
  );
}
