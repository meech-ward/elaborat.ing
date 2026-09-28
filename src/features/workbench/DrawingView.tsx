import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
// Excalidraw's own layout. Without it the canvas sizes itself to its content,
// which grows without limit.
import "@excalidraw/excalidraw/index.css";
import { Banner, BannerAction, commandShortcut, isApplePlatform, type MenuEntry } from "@/features/design-system";
import {
  DrawingCanvas,
  exportDrawingPng,
  exportDrawingSvg,
  parseDrawingFile,
  saveDrawingFile,
  scenesEqual,
  summarizeDrawing,
  type DrawingCanvasApi,
  type DrawingScene,
  type ParsedDrawing,
} from "@/features/drawings/index.ts";
import { useCanvasComments } from "@/features/comments";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { SourceEditor, type SourceEditorApi } from "@/features/source";
import type { SourcePatch } from "@/features/document";
import { ConflictBanner } from "./ConflictBanner";
import { downloadBlob, downloadText } from "./download";
import { buildNativeDownload } from "./nativeDownload";
import type { OperationSession } from "./operationSession";
import { readProjectView, writeProjectView } from "./projectViews";
import type { TabFile } from "./tabs";
import { useCanvasPresentation, useCanvasTheme } from "./viewTheme";
import { FileHeader } from "./FileHeader";
import { useCanvasStage } from "./canvasStage";
import { canvasViewFrom, useCanvasViews, type CanvasView } from "./canvasViews";
import { useDesktopFrame } from "./tabline";
import type { WorkspaceStore } from "./workspaceStore";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function tryParse(content: string, path: string): { parsed: ParsedDrawing | null; error: string | null } {
  try {
    return { parsed: parseDrawingFile(content, path), error: null };
  } catch (error) {
    return { parsed: null, error: message(error) };
  }
}

/** One edit that turns `before` into `after`: the changed middle, with the shared start and end kept. */
function patchBetween(before: string, after: string): SourcePatch {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { from: start, to: before.length - end, expected: before.slice(start, before.length - end), insert: after.slice(start, after.length - end) };
}

/** The offset of a line and column in `text`, each clamped to what the text has. */
function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  const row = Math.min(Math.max(line, 1), lines.length);
  let offset = 0;
  for (let index = 0; index < row - 1; index += 1) offset += lines[index].length + 1;
  return offset + Math.min(Math.max(column, 1), lines[row - 1].length + 1) - 1;
}

/**
 * One open drawing (`.excalidraw`, or Obsidian's `.excalidraw.md`): the
 * Excalidraw canvas, its file as text, or on a desktop both (Split: the text
 * over the left half of the canvas, each following the other's edits while
 * the text parses; while it does not, the canvas is view-only and keeps the
 * last valid scene). Saving writes the file on this
 * device, checked against the saved copy the edits started from. An
 * untouched drawing is never rewritten, and a file that does not parse opens
 * as text with the error shown, so it can be fixed here.
 */
export function DrawingView({
  client,
  initial,
  active,
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
  /** Why the project cannot be changed, or null. The drawing is then shown in view mode, never edited or kept as a draft. */
  readOnly?: string | null;
}) {
  const path = initial.path;
  const theme = useCanvasTheme();
  const desktop = useDesktopFrame();
  const present = useCanvasPresentation("drawing");
  const [opened] = useState(() => tryParse(initial.content, path));
  const [original, setOriginal] = useState<ParsedDrawing | null>(opened.parsed);
  const [scene, setScene] = useState<DrawingScene | null>(opened.parsed?.scene ?? null);
  const [baseRevision, setBaseRevision] = useState<string | null>(initial.revision);
  // The saved copy that "unsaved" compares against: it moves on every save and adopted change.
  const [savedText, setSavedText] = useState(initial.savedContent !== undefined ? initial.savedContent ?? "" : initial.revision ? initial.content : "");
  const [mode, setMode] = useState<CanvasView>(() => {
    const stored = canvasViewFrom(readProjectView(client.persistenceKey, path));
    return !opened.parsed && stored === "canvas" ? "source" : stored;
  });
  useEffect(() => {
    writeProjectView(client.persistenceKey, path, mode);
  }, [client.persistenceKey, path, mode]);
  const selectRef = useRef<(next: CanvasView) => void>(() => {});
  const { view, header: viewHeader } = useCanvasViews(mode, active, (next) => selectRef.current(next), "Drawing view");
  const [sourceDraft, setSourceDraft] = useState(initial.content);
  const [sourceError, setSourceError] = useState<string | null>(opened.error);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ revision: string; content: string | null } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState<{ revision: string; content: string } | null>(null);
  const frozen = useRef(false);
  const locked = blocked || Boolean(readOnly);
  useLayoutEffect(() => {
    frozen.current = locked;
  }, [locked]);

  const dirty = useMemo(() => {
    const canvasDirty = original && scene ? !scenesEqual(original.scene, scene) : false;
    return canvasDirty || sourceDraft !== savedText;
  }, [original, scene, sourceDraft, savedText]);

  /** The file's text as it stands: the canvas serialized, or the source being edited (Split keeps them the same). */
  const currentText = useCallback(() => {
    if (!dirty) return savedText;
    return view === "canvas" && scene && original ? saveDrawingFile(scene, original).text : sourceDraft;
  }, [dirty, savedText, view, scene, original, sourceDraft]);

  // Unsaved edits are kept on the device (a draft equal to the saved copy is dropped).
  const persistDraft = useCallback(async () => {
    if (readOnly) return;
    await client.persistDrafts([{ path, content: currentText(), baseRevision }]);
  }, [client, path, currentText, baseRevision, readOnly]);
  useEffect(() => {
    void persistDraft().catch((error: unknown) => setNotice(`Could not keep unsaved edits on this device: ${message(error)}`));
  }, [persistDraft]);

  useEffect(() => {
    onState(path, dirty, notice);
  }, [path, dirty, notice, onState]);

  const operation = useRef({ dirty, saving, reconciled: false });
  useLayoutEffect(() => {
    operation.current = { dirty, saving, reconciled: baseRevision !== null && !conflict && !changedElsewhere && !conflicted };
  }, [dirty, saving, baseRevision, conflict, changedElsewhere, conflicted]);
  useLayoutEffect(() => {
    onOperationSession?.(path, {
      state: () => ({ ...operation.current, pending: false }),
      freeze: () => {
        frozen.current = true;
      },
      release: () => {
        frozen.current = locked;
      },
      persistDraft,
    });
    return () => onOperationSession?.(path, null);
  }, [onOperationSession, path, persistDraft, locked]);

  const summary = useMemo(() => (scene ? summarizeDrawing(scene) : null), [scene]);
  const sourceApi = useRef<SourceEditorApi | null>(null);
  const latest = useRef({ scene, sourceDraft, original });
  useEffect(() => {
    latest.current = { scene, sourceDraft, original };
  }, [scene, sourceDraft, original]);

  // Split: canvas edits rewrite the source a moment later, as one undo step
  // that keeps the cursor on its line. The text written is remembered so it
  // is not read back into the canvas.
  const cursor = useRef({ line: 1, column: 1 });
  const fromCanvas = useRef<string | null>(opened.parsed ? initial.content : null);
  const canvasTimer = useRef<number | null>(null);
  const writeCanvasToSource = useCallback((): string => {
    const { scene: current, original: base, sourceDraft: before } = latest.current;
    // Only a canvas edit still waiting to be written; otherwise the source
    // is current (and may be text being fixed, which is never overwritten).
    if (canvasTimer.current === null) return before;
    window.clearTimeout(canvasTimer.current);
    canvasTimer.current = null;
    if (!current || !base || frozen.current) return before;
    const saved = saveDrawingFile(current, base);
    const text = saved.noop ? base.originalSource : saved.text;
    if (text === before) return before;
    fromCanvas.current = text;
    latest.current = { ...latest.current, sourceDraft: text };
    sourceApi.current?.applyExternalPatches([patchBetween(before, text)], {
      after: { anchor: offsetAt(text, cursor.current.line, cursor.current.column), head: offsetAt(text, cursor.current.line, cursor.current.column) },
    });
    setSourceDraft(text);
    return text;
  }, []);
  useEffect(() => () => {
    if (canvasTimer.current !== null) window.clearTimeout(canvasTimer.current);
  }, []);
  // Split: source edits reach the canvas while the source parses.
  const readSource = useCallback((text: string) => {
    if (text === fromCanvas.current) {
      // Text the canvas wrote is the canvas already.
      setSourceError(null);
      return;
    }
    const { parsed, error } = tryParse(text, path);
    setSourceError(error);
    if (!parsed) return;
    setOriginal(parsed);
    setScene(parsed.scene);
  }, [path]);

  const adopt = useCallback((content: string, revision: string) => {
    const { parsed, error } = tryParse(content, path);
    setOriginal(parsed);
    if (parsed) setScene(parsed.scene);
    setSourceError(error);
    if (!parsed) setMode("source");
    setSourceDraft(content);
    setSavedText(content);
    setBaseRevision(revision);
    setConflict(null);
    setChangedElsewhere(null);
  }, [path]);

  const selectView = useCallback((next: CanvasView) => {
    if (next === view) return;
    if (view === "canvas") {
      // The source takes the canvas as it stands.
      if (original && scene) {
        const saved = saveDrawingFile(scene, original);
        const text = saved.noop ? original.originalSource : saved.text;
        fromCanvas.current = text;
        setSourceDraft(text);
      }
      setSourceError(null);
      setMode(next);
      return;
    }
    if (view === "split") {
      // Split keeps the canvas and a source that parses the same; one that
      // does not parse stays in place, with the canvas on its last valid scene.
      writeCanvasToSource();
      if (next === "canvas" && sourceError !== null) return;
      setMode(next);
      return;
    }
    if (next === "split") {
      // The canvas takes the source when it parses.
      readSource(sourceDraft);
    } else {
      const { parsed, error } = tryParse(sourceDraft, path);
      if (!parsed) {
        // The canvas keeps its last valid scene; the text is fixed in place.
        setSourceError(error);
        return;
      }
      setOriginal(parsed);
      setScene(parsed.scene);
      setSourceError(null);
    }
    setMode(next);
  }, [view, original, scene, sourceDraft, sourceError, path, writeCanvasToSource, readSource]);
  useEffect(() => {
    selectRef.current = selectView;
  }, [selectView]);

  const save = useCallback(async (overwrite?: string) => {
    if (frozen.current || saving) return;
    const text = view === "split" ? writeCanvasToSource() : view === "source" ? sourceDraft : scene && original ? saveDrawingFile(scene, original).text : null;
    if (text === null) return;
    const { parsed, error } = tryParse(text, path);
    if (!parsed) {
      setSourceError(error);
      setNotice("Not saved: the file is not a valid drawing.");
      return;
    }
    if (text === savedText && baseRevision !== null && overwrite === undefined) {
      setNotice("No changes to save.");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await client.write(path, { content: text, expectedRevision: overwrite ?? baseRevision });
      setOriginal(parsed);
      setSourceError(null);
      // Keep edits made while the save was in flight.
      if (latest.current.scene === scene && latest.current.sourceDraft === sourceDraft) {
        setScene(parsed.scene);
        setSourceDraft(text);
      }
      setSavedText(text);
      setBaseRevision(saved.revision);
      setConflict(null);
      setChangedElsewhere(null);
      setNotice(`Saved ${path}.`);
    } catch (error) {
      if (error instanceof LocalConflictError) {
        setConflict({ revision: error.currentRevision, content: error.currentContent });
        setNotice(null);
      } else {
        setNotice(`Save failed: ${message(error)}`);
      }
    } finally {
      setSaving(false);
    }
  }, [view, sourceDraft, scene, original, path, savedText, baseRevision, client, saving, writeCanvasToSource]);

  // Ctrl or Cmd+S saves the active drawing (the source editor handles its own).
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if ((event.target as HTMLElement | null)?.closest(".monaco-editor")) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, save]);

  // A newer saved copy (from another tab, or brought in by sync): an untouched
  // drawing takes it; one with edits keeps them and offers the choice.
  const checking = useRef(false);
  useEffect(() => {
    if (savedRevision === undefined || savedRevision === null || savedRevision === baseRevision || saving) return;
    if (changedElsewhere?.revision === savedRevision || checking.current) return;
    checking.current = true;
    void client
      .read(path)
      .then((read) => {
        if (read.revision === null || read.savedContent === null || read.revision === baseRevision) return;
        if (dirty) setChangedElsewhere({ revision: read.revision, content: read.savedContent });
        else adopt(read.savedContent, read.revision);
      })
      .catch(() => {
        // The next list refresh tries again.
      })
      .finally(() => {
        checking.current = false;
      });
  }, [savedRevision, baseRevision, saving, changedElsewhere, client, path, dirty, adopt]);

  const baseName = path.split("/").pop()?.replace(/\.md$/, "") ?? "drawing";
  const exportSvg = useCallback(async () => {
    if (!scene) return;
    try {
      downloadText(await exportDrawingSvg(scene), `${baseName}.svg`, "image/svg+xml");
      setNotice("Exported SVG.");
    } catch (error) {
      setNotice(`SVG export failed: ${message(error)}`);
    }
  }, [scene, baseName]);
  const exportPng = useCallback(async () => {
    if (!scene) return;
    try {
      downloadBlob(await exportDrawingPng(scene, { scale: 2 }), `${baseName}.png`);
      setNotice("Exported PNG.");
    } catch (error) {
      setNotice(`PNG export failed: ${message(error)}`);
    }
  }, [scene, baseName]);
  const exportNative = useCallback(() => {
    const result = buildNativeDownload({ view: view === "canvas" ? "canvas" : "source", scene, sourceDraft, path });
    if (!result.ok) {
      setNotice(`Excalidraw export failed: ${result.error}`);
      return;
    }
    downloadText(result.text, result.filename, "application/json");
    setNotice(`Exported ${result.filename}.`);
  }, [view, scene, sourceDraft, path]);

  // Comments on the drawing's elements: pins on the canvas, and Comment on
  // the selected element. The panel's Go to shows an element on the canvas.
  const canvasApi = useRef<DrawingCanvasApi | null>(null);
  // From Code, Go to shows the canvas first, then the element on it.
  const revealAfterShow = useRef<string | null>(null);
  const canvasComments = useCanvasComments({
    path,
    elements: scene?.elements ?? null,
    onReveal: (elementId, focus) => {
      if (view !== "source") {
        canvasApi.current?.revealElement(elementId, focus);
        return;
      }
      if (!focus) return;
      revealAfterShow.current = elementId;
      selectRef.current("canvas");
    },
  });
  useEffect(() => {
    if (view === "source" || revealAfterShow.current === null) return;
    // After the canvas has placed its scene in the area it now shows in.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const elementId = revealAfterShow.current;
        revealAfterShow.current = null;
        if (elementId !== null) canvasApi.current?.revealElement(elementId);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  const duplicateKey = commandShortcut("D", isApplePlatform());
  const fullBleed = desktop && active && view !== "source" && scene !== null;
  const [stageRef, onStageScroll] = useCanvasStage(fullBleed);
  // In Split the canvas is view-only while the source does not parse.
  const canvasViewOnly = Boolean(readOnly) || (view === "split" && sourceError !== null);

  return (
    <div className="wb-native-view" data-canvas-bleed={fullBleed || undefined} data-view={view}>
      <FileHeader
        path={path}
        active={active}
        navigation={navigation}
        view={viewHeader}
        save={!readOnly && dirty ? { disabled: saving, onSave: () => void save() } : null}
        actions={[
          ...(readOnly ? [] : [{ label: "Save", disabled: saving, onSelect: () => void save() }]),
          ...(onDuplicate ? [{ label: "Duplicate", shortcut: duplicateKey.label, keyShortcuts: duplicateKey.aria, onSelect: onDuplicate }] : []),
          { label: "SVG", disabled: !scene, onSelect: () => void exportSvg() },
          { label: "PNG", disabled: !scene, onSelect: () => void exportPng() },
          { label: "Excalidraw", onSelect: exportNative },
        ] satisfies MenuEntry[]}
      />

      {/* The saved state, the drawing's counts and the last notice, for
          screen readers: Save and the tab's unsaved dot show it on screen. */}
      <div aria-live="polite" className="sr-only">
        <span>{dirty ? "Unsaved changes" : "Saved"}</span>
        {summary && (
          <span>
            {summary.activeCount} elements · {summary.texts.length} text · {summary.looseArrows.length} loose arrows
          </span>
        )}
        {saving && <span>Saving…</span>}
        {notice && <span>{notice}</span>}
      </div>

      {sourceError && (
        <Banner tone="danger" className="mt-2">
          {original
            ? `This is not a valid drawing: ${sourceError} The canvas keeps the last valid scene.`
            : `This file is not a valid drawing, so it opened as text: ${sourceError} Nothing was changed.`}
        </Banner>
      )}

      {conflicted && onResolveConflict && (
        <ConflictBanner
          name={path}
          path={path}
          client={client}
          compareAs={{ kind: "drawing" }}
          noun="drawing"
          hasUnsavedEdits={() => dirty}
          onResolveConflict={onResolveConflict}
          onNotice={setNotice}
        />
      )}

      {conflict && (
        <Banner
          role="alert"
          className="mt-2"
          action={
            <span className="inline-flex flex-wrap gap-x-3">
              {conflict.content !== null && (
                <BannerAction onClick={() => adopt(conflict.content!, conflict.revision)}>Load the saved version</BannerAction>
              )}
              <BannerAction onClick={() => void save(conflict.revision)}>Save mine over it</BannerAction>
            </span>
          }
        >
          {path} changed after you started editing it, so nothing was saved. Your edits are still here.
        </Banner>
      )}

      {changedElsewhere && (
        <Banner
          role="alert"
          className="mt-2"
          action={
            <span className="inline-flex flex-wrap gap-x-3">
              <BannerAction
                onClick={() => {
                  if (window.confirm("Load the saved version and discard your unsaved edits?")) adopt(changedElsewhere.content, changedElsewhere.revision);
                }}
              >
                Load the saved version
              </BannerAction>
              <BannerAction onClick={() => void save(changedElsewhere.revision)}>Save mine over it</BannerAction>
            </span>
          }
        >
          {path} was saved somewhere else while you were editing it. Your edits are still here.
        </Banner>
      )}

      {scene && (
        <div hidden={view === "source"} className="wb-native-stage" data-canvas-stage="" ref={stageRef}>
          <DrawingCanvas
            scene={scene}
            onChange={(next) => {
              if (frozen.current || canvasViewOnly) return;
              latest.current = { ...latest.current, scene: next };
              setScene(next);
              if (view !== "split") return;
              if (canvasTimer.current !== null) window.clearTimeout(canvasTimer.current);
              canvasTimer.current = window.setTimeout(writeCanvasToSource, 150);
            }}
            theme={theme}
            present={present}
            onScrollChange={onStageScroll}
            compact={!desktop}
            active={active && view !== "source"}
            viewOnly={canvasViewOnly}
            comments={canvasComments}
            apiRef={canvasApi}
          />
        </div>
      )}
      <div hidden={view === "canvas"} className="wb-native-stage wb-native-source">
        <SourceEditor
          initialText={initial.content}
          documentText={sourceDraft}
          format="md"
          documentId={1}
          editorLanguage="json"
          visible={active && view !== "canvas"}
          renderError={sourceError}
          onChange={(text) => {
            if (frozen.current) return;
            latest.current = { ...latest.current, sourceDraft: text };
            setSourceDraft(text);
            if (view === "split") readSource(text);
          }}
          onCursor={(line, column) => {
            cursor.current = { line, column };
          }}
          onSave={() => (readOnly ? setNotice(readOnly) : void save())}
          apiRef={sourceApi}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
