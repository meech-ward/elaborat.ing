import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
// Excalidraw's own layout. Without it the canvas sizes itself to its content,
// which grows without limit.
import "@excalidraw/excalidraw/index.css";
import { Download, FileJson, Pencil, Save } from "lucide-react";
import {
  DrawingCanvas,
  exportDrawingPng,
  exportDrawingSvg,
  parseDrawingFile,
  saveDrawingFile,
  scenesEqual,
  summarizeDrawing,
  type DrawingScene,
  type ParsedDrawing,
} from "@/features/drawings/index.ts";
import { LocalConflictError } from "@/features/project-storage/fileStore";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { SourceEditor, type SourceEditorApi } from "@/features/source";
import { CompactFileIdentity } from "./compactWorkbench";
import { ConflictBanner } from "./ConflictBanner";
import { downloadBlob, downloadText } from "./download";
import { buildNativeDownload } from "./nativeDownload";
import type { OperationSession } from "./operationSession";
import { readProjectView, writeProjectView } from "./projectViews";
import type { TabFile } from "./tabs";
import { ViewSwitcher } from "./ViewSwitcher";
import { useCanvasTheme } from "./viewTheme";
import { ActionMenu } from "./WorkbenchChrome";
import { TablineActions } from "./tabline";
import type { WorkspaceStore } from "./workspaceStore";

const toolbarButton =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";
const bannerButton =
  "inline-flex min-h-10 items-center rounded-lg border border-amber-400 bg-white px-3 font-medium dark:border-amber-700 dark:bg-neutral-900";
const banner =
  "mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function tryParse(content: string, path: string): { parsed: ParsedDrawing | null; error: string | null } {
  try {
    return { parsed: parseDrawingFile(content, path), error: null };
  } catch (error) {
    return { parsed: null, error: message(error) };
  }
}

/**
 * One open drawing (`.excalidraw`, or Obsidian's `.excalidraw.md`): the
 * Excalidraw canvas, or its file as text. Saving writes the file on this
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
  /** Why the project cannot be changed, or null. The drawing is then shown in view mode, never edited or kept as a draft. */
  readOnly?: string | null;
}) {
  const path = initial.path;
  const theme = useCanvasTheme();
  const [opened] = useState(() => tryParse(initial.content, path));
  const [original, setOriginal] = useState<ParsedDrawing | null>(opened.parsed);
  const [scene, setScene] = useState<DrawingScene | null>(opened.parsed?.scene ?? null);
  const [baseRevision, setBaseRevision] = useState<string | null>(initial.revision);
  // The saved copy that "unsaved" compares against: it moves on every save and adopted change.
  const [savedText, setSavedText] = useState(initial.savedContent !== undefined ? initial.savedContent ?? "" : initial.revision ? initial.content : "");
  const [view, setView] = useState<"canvas" | "source">(() =>
    !opened.parsed || readProjectView(client.persistenceKey, path) === "source" ? "source" : "canvas",
  );
  useEffect(() => {
    writeProjectView(client.persistenceKey, path, view);
  }, [client.persistenceKey, path, view]);
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

  /** The file's text as it stands: the canvas serialized, or the source being edited. */
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
  const latest = useRef({ scene, sourceDraft });
  useEffect(() => {
    latest.current = { scene, sourceDraft };
  }, [scene, sourceDraft]);

  const adopt = useCallback((content: string, revision: string) => {
    const { parsed, error } = tryParse(content, path);
    setOriginal(parsed);
    if (parsed) setScene(parsed.scene);
    setSourceError(error);
    if (!parsed) setView("source");
    setSourceDraft(content);
    setSavedText(content);
    setBaseRevision(revision);
    setConflict(null);
    setChangedElsewhere(null);
  }, [path]);

  const switchToSource = useCallback(() => {
    if (original && scene) {
      const saved = saveDrawingFile(scene, original);
      setSourceDraft(saved.noop ? original.originalSource : saved.text);
    }
    setSourceError(null);
    setView("source");
  }, [original, scene]);

  const switchToCanvas = useCallback(() => {
    const { parsed, error } = tryParse(sourceDraft, path);
    if (!parsed) {
      // The canvas keeps its last valid scene; the text is fixed in place.
      setSourceError(error);
      return;
    }
    setOriginal(parsed);
    setScene(parsed.scene);
    setSourceError(null);
    setView("canvas");
  }, [sourceDraft, path]);

  const save = useCallback(async (overwrite?: string) => {
    if (frozen.current || saving) return;
    const text = view === "source" ? sourceDraft : scene && original ? saveDrawingFile(scene, original).text : null;
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
  }, [view, sourceDraft, scene, original, path, savedText, baseRevision, client, saving]);

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
    const result = buildNativeDownload({ view, scene, sourceDraft, path });
    if (!result.ok) {
      setNotice(`Excalidraw export failed: ${result.error}`);
      return;
    }
    downloadText(result.text, result.filename, "application/json");
    setNotice(`Exported ${result.filename}.`);
  }, [view, scene, sourceDraft, path]);

  return (
    <div className="wb-native-view">
      <TablineActions active={active}>
      <div className="wb-native-toolbar" data-compact-toolbar={navigation ? "" : undefined}>
        <CompactFileIdentity navigation={navigation} path={path} />
        <ViewSwitcher
          ariaLabel="Drawing view"
          options={[
            { value: "canvas" as const, label: "Canvas" },
            { value: "source" as const, label: "Source" },
          ]}
          active={view}
          onSelect={(value) => (value === "canvas" ? switchToCanvas() : switchToSource())}
        />
        <ActionMenu>
          {!readOnly && (
            <button type="button" disabled={saving} onClick={() => void save()} className={toolbarButton}>
              <Save className="size-4" aria-hidden /> Save
            </button>
          )}
          <button type="button" disabled={!scene} onClick={() => void exportSvg()} className={toolbarButton}>
            <Download className="size-4" aria-hidden /> SVG
          </button>
          <button type="button" disabled={!scene} onClick={() => void exportPng()} className={toolbarButton}>
            <Download className="size-4" aria-hidden /> PNG
          </button>
          <button type="button" onClick={exportNative} className={toolbarButton}>
            <FileJson className="size-4" aria-hidden /> Excalidraw
          </button>
        </ActionMenu>
      </div>
      </TablineActions>

      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-neutral-200 py-1.5 font-mono text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
      >
        <span>{dirty ? "Unsaved changes" : "Saved"}</span>
        {summary && (
          <span className="wb-native-detail">
            {summary.activeCount} elements · {summary.texts.length} text · {summary.looseArrows.length} loose arrows
          </span>
        )}
        {saving && <span>Saving…</span>}
        {notice && <span className="text-neutral-700 dark:text-neutral-200">{notice}</span>}
      </div>

      {sourceError && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {original
            ? `This is not a valid drawing: ${sourceError} The canvas keeps the last valid scene.`
            : `This file is not a valid drawing, so it opened as text: ${sourceError} Nothing was changed.`}
        </p>
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
        <div role="alert" className={banner}>
          <p>{path} changed after you started editing it, so nothing was saved. Your edits are still here.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {conflict.content !== null && (
              <button type="button" onClick={() => adopt(conflict.content!, conflict.revision)} className={bannerButton}>
                Load the saved version
              </button>
            )}
            <button type="button" onClick={() => void save(conflict.revision)} className={bannerButton}>
              Save mine over it
            </button>
          </div>
        </div>
      )}

      {changedElsewhere && (
        <div role="alert" className={banner}>
          <p>{path} was saved somewhere else while you were editing it. Your edits are still here.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Load the saved version and discard your unsaved edits?")) adopt(changedElsewhere.content, changedElsewhere.revision);
              }}
              className={bannerButton}
            >
              Load the saved version
            </button>
            <button type="button" onClick={() => void save(changedElsewhere.revision)} className={bannerButton}>
              Save mine over it
            </button>
          </div>
        </div>
      )}

      {scene && (
        <div hidden={view !== "canvas"} className="wb-native-stage">
          <DrawingCanvas
            scene={scene}
            onChange={(next) => {
              if (!frozen.current) setScene(next);
            }}
            theme={theme}
            active={active && view === "canvas"}
            viewOnly={Boolean(readOnly)}
          />
        </div>
      )}
      <div hidden={view !== "source"} className="wb-native-stage">
        <SourceEditor
          initialText={initial.content}
          documentText={sourceDraft}
          format="md"
          documentId={1}
          editorLanguage="json"
          visible={active && view === "source"}
          renderError={sourceError}
          onChange={(text) => {
            if (!frozen.current) setSourceDraft(text);
          }}
          onCursor={() => {}}
          onSave={() => (readOnly ? setNotice(readOnly) : void save())}
          apiRef={sourceApi}
          readOnly={readOnly}
        />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        {view === "canvas" ? <Pencil className="size-3.5" aria-hidden /> : <FileJson className="size-3.5" aria-hidden />}
        {view === "canvas"
          ? "Canvas: tools, labels, arrows and freehand, with undo. Opening a drawing never rewrites it."
          : "The file as text. Switch to Canvas to check it; if it does not parse, the canvas keeps the last valid scene."}
      </p>
    </div>
  );
}
