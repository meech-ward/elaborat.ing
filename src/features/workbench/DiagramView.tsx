import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download, RotateCcw, Save, WandSparkles } from "lucide-react";
import { MenuShortcut } from "@/components/ui/menu";
// Excalidraw's own layout, for the generated canvas.
import "@excalidraw/excalidraw/index.css";
import { DrawingCanvas, exportDrawingPng, exportDrawingSvg, scenesEqual, type DrawingScene } from "@/features/drawings/index.ts";
import { parseDrawingFile } from "@/features/drawings/parse.ts";
import { saveDrawingFile } from "@/features/drawings/serialize.ts";
import { LocalConflictError, type LocalChange } from "@/features/project-storage/fileStore";
import type { ConflictChoice } from "@/features/project-storage/sync";
import { SourceEditor, type SourceEditorApi } from "@/features/source";
import { compileD2Diagram } from "@/features/structured/compiler";
import { diagramSidecarText } from "@/features/structured/diagramPersistence";
import { changedGeneratedLabels, isNodeLabel, synchronizeLabels, type LabelEdit } from "@/features/structured/labelSync";
import {
  readSidecarFile,
  regenerateDiagram,
  resetOverrides,
  sidecarPathFor,
  toDrawingScene,
  toNativeScene,
  writeSidecarFile,
} from "@/features/structured/structuredClient";
import type { Diagnostic, GeneratedBaseline, MergeConflict } from "@/features/structured/types.ts";
import { CompactFileIdentity } from "./compactWorkbench";
import { ConflictBanner } from "./ConflictBanner";
import { nativePathFor, projectDiagramArtifact, readDiagramCompanion } from "./diagramArtifact";
import { downloadBlob, downloadText } from "./download";
import type { OperationSession } from "./operationSession";
import { readProjectView, writeProjectView } from "./projectViews";
import type { TabFile } from "./tabs";
import { ViewSwitcher } from "./ViewSwitcher";
import { useCanvasPresentation, useCanvasTheme } from "./viewTheme";
import { ActionMenu } from "./WorkbenchChrome";
import { duplicateShortcutLabel } from "./viewShortcuts";
import { useCanvasStage } from "./canvasStage";
import { TablineActions, useDesktopFrame } from "./tabline";
import type { WorkspaceStore } from "./workspaceStore";

const toolbarButton =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";
const bannerButton =
  "inline-flex min-h-10 items-center rounded-lg border border-amber-400 bg-white px-3 font-medium dark:border-amber-700 dark:bg-neutral-900";
const banner =
  "mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Compile for the planners that take a raw diagram, failing on a syntax error. */
async function compileOrThrow(source: string) {
  const compiled = await compileD2Diagram(source);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.diagram;
}

/**
 * One open D2 diagram: its code, and the canvas generated from it. A diagram
 * is three files saved together: the `.d2` source, the generated `.excalidraw`
 * canvas (where freehand additions and moved shapes live), and the `.d2.json`
 * sidecar with the generation baseline. They save on the device as one change,
 * so sync sends them as one `save_files` call. D2 compiles in the browser. A
 * compile error keeps the last valid canvas and never touches saved files.
 */
export function DiagramView({
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
  /** Why the project cannot be changed, or null. The code and canvas are then shown, never edited or kept as drafts. */
  readOnly?: string | null;
}) {
  const path = initial.path;
  const theme = useCanvasTheme();
  const desktop = useDesktopFrame();
  const present = useCanvasPresentation("diagram", desktop);
  const nativePath = useMemo(() => nativePathFor(path), [path]);
  const sidecarPath = useMemo(() => sidecarPathFor(path), [path]);

  const [opened, setOpened] = useState(() => ({
    source: initial.content,
    saved: initial.savedContent !== undefined ? initial.savedContent ?? "" : initial.revision ? initial.content : "",
    revision: initial.revision,
  }));
  const [source, setSource] = useState(opened.source);
  const [savedSource, setSavedSource] = useState(opened.saved);
  const [baseRevision, setBaseRevision] = useState<string | null>(opened.revision);
  const [nativeRevision, setNativeRevision] = useState<string | null>(null);
  const [sidecarRevision, setSidecarRevision] = useState<string | null>(null);
  const [scene, setScene] = useState<DrawingScene | null>(null);
  const [savedScene, setSavedScene] = useState<DrawingScene | null>(null);
  const [savedSidecarText, setSavedSidecarText] = useState<string | null>(null);
  const [savedNativeBytes, setSavedNativeBytes] = useState<string | null>(null);
  const [savedSidecarBytes, setSavedSidecarBytes] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<GeneratedBaseline | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
  const [view, setView] = useState<"code" | "canvas">(() => (readProjectView(client.persistenceKey, path) === "code" ? "code" : "canvas"));
  useEffect(() => {
    writeProjectView(client.persistenceKey, path, view);
  }, [client.persistenceKey, path, view]);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLabels, setPendingLabels] = useState<LabelEdit[]>([]);
  const [labelError, setLabelError] = useState<string | null>(null);
  /** A save was refused because one of the three files changed after editing began. */
  const [conflict, setConflict] = useState<{ path: string; revision: string; content: string | null } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState<string | null>(null);
  const frozen = useRef(false);
  const locked = blocked || Boolean(readOnly);
  useLayoutEffect(() => {
    frozen.current = locked;
  }, [locked]);
  const sourceApi = useRef<SourceEditorApi | null>(null);
  // The latest code and canvas, ahead of React's render: edits write it at
  // once, and a layout effect (which runs as a render commits, before any
  // later input) catches the other updates without undoing a newer edit.
  const latest = useRef({ source, scene });
  useLayoutEffect(() => {
    latest.current = { source, scene };
  }, [source, scene]);

  const changeSource = useCallback((text: string) => {
    if (frozen.current) return;
    latest.current = { ...latest.current, source: text };
    setLabelError(null);
    setSource(text);
  }, []);

  const changeCanvas = useCallback((next: DrawingScene) => {
    if (frozen.current) return;
    const previous = latest.current.scene;
    latest.current = { ...latest.current, scene: next };
    setScene(next);
    if (!previous || !baseline) return;
    const changed = changedGeneratedLabels(toNativeScene(previous), toNativeScene(next), baseline);
    const edits = changed.filter((edit) => isNodeLabel(edit, baseline));
    if (changed.length !== edits.length) setNotice("This generated text stays a canvas-only change. Only node labels update the D2 code.");
    if (!edits.length) return;
    setLabelError(null);
    setPendingLabels((pending) => {
      const combined = new Map(pending.map((edit) => [edit.elementId, edit]));
      for (const edit of edits) {
        const original = combined.get(edit.elementId)?.before ?? edit.before;
        if (original === edit.after) combined.delete(edit.elementId);
        else combined.set(edit.elementId, { ...edit, before: original });
      }
      return [...combined.values()];
    });
  }, [baseline]);

  // A renamed node label on the canvas becomes a D2 edit, once D2 accepts it.
  useEffect(() => {
    if (!pendingLabels.length || !baseline || !scene) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await synchronizeLabels(source, baseline, pendingLabels, compileOrThrow);
        if (!alive || latest.current.source !== source || latest.current.scene !== scene) return;
        if (result.error) {
          setLabelError(result.error);
          return;
        }
        // The code editor records the change in its own undo history.
        if (result.source !== source) {
          sourceApi.current?.applyExternalPatches([{ from: 0, to: source.length, expected: source, insert: result.source }]);
          changeSource(result.source);
        }
        setBaseline(result.baseline);
        setPendingLabels([]);
        setLabelError(null);
      })();
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [source, scene, baseline, pendingLabels, changeSource]);

  // Elements, image files and canvas preferences all count, as for drawings.
  const sceneDirty = useMemo(() => {
    if (!scene || !savedScene) return scene !== savedScene;
    return !scenesEqual(savedScene, scene);
  }, [scene, savedScene]);
  const sidecarText = useMemo(() => (scene ? diagramSidecarText(baseline, scene) : null), [baseline, scene]);
  const dirty = source !== savedSource || sceneDirty || sidecarText !== savedSidecarText;

  // Unsaved edits to any of the three files are kept on the device.
  const persistDraft = useCallback(async () => {
    if (!booted || !scene || readOnly) return;
    await client.persistDrafts([
      { path, content: source, baseRevision },
      ...(dirty || savedNativeBytes !== null
        ? [{ path: nativePath, content: dirty ? saveDrawingFile(scene, null).text : savedNativeBytes!, baseRevision: nativeRevision }]
        : []),
      ...((dirty ? sidecarText : savedSidecarBytes) === null
        ? []
        : [{ path: sidecarPath, content: (dirty ? sidecarText : savedSidecarBytes)!, baseRevision: sidecarRevision }]),
    ]);
  }, [booted, scene, readOnly, client, path, source, baseRevision, dirty, savedNativeBytes, nativePath, nativeRevision, sidecarText, savedSidecarBytes, sidecarPath, sidecarRevision]);
  useEffect(() => {
    void persistDraft().catch((error: unknown) => setNotice(`Could not keep unsaved edits on this device: ${message(error)}`));
  }, [persistDraft]);

  useEffect(() => {
    onState(path, dirty, notice);
  }, [path, dirty, notice, onState]);

  const operation = useRef({ dirty, saving, pending: true, reconciled: false });
  useLayoutEffect(() => {
    operation.current = {
      dirty,
      saving,
      pending: !booted || regenerating || pendingLabels.length > 0,
      reconciled: booted && !bootError && baseRevision !== null && !conflict && !changedElsewhere && !conflicted && conflicts.length === 0 && pendingLabels.length === 0,
    };
  }, [dirty, saving, booted, regenerating, pendingLabels.length, bootError, baseRevision, conflict, changedElsewhere, conflicted, conflicts.length]);
  useLayoutEffect(() => {
    onOperationSession?.(path, {
      state: () => operation.current,
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

  // Load: read the generated files, compile the source, and merge.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [native, sidecar] = await Promise.all([readDiagramCompanion(client, nativePath), readDiagramCompanion(client, sidecarPath)]);
        if (!alive) return;
        setNativeRevision(native?.revision ?? null);
        setSidecarRevision(sidecar?.revision ?? null);
        setSavedNativeBytes(native?.savedContent ?? null);
        setSavedSidecarBytes(sidecar?.savedContent ?? null);
        const result = await projectDiagramArtifact({
          source: opened.source,
          nativePath,
          nativeContent: native?.content ?? null,
          sidecarContent: sidecar?.content ?? null,
          compile: async () => {
            const compiled = await compileD2Diagram(opened.source);
            return compiled.ok ? { diagram: compiled.diagram, error: null } : { diagram: null, error: compiled.error };
          },
        });
        if (!alive) return;
        setScene(result.scene);
        setBaseline(result.baseline);
        setDiagnostics(result.diagnostics);
        setConflicts(result.conflicts);
        setSavedScene(native?.savedContent ? parseDrawingFile(native.savedContent, nativePath).scene : null);
        setSavedSidecarText(sidecar?.savedContent ? writeSidecarFile(readSidecarFile(sidecar.savedContent)) : null);
        setPendingLabels(result.pendingLabels);
        if (!result.ok) setView("code");
        setBootError(null);
      } catch (error) {
        if (alive) setBootError(message(error));
      } finally {
        if (alive) setBooted(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, opened, nativePath, sidecarPath]);

  const regenerate = useCallback(async () => {
    if (frozen.current || !scene || regenerating) return;
    if (pendingLabels.length) {
      setNotice("Wait for the canvas label to reach the code before regenerating.");
      return;
    }
    setRegenerating(true);
    setNotice(null);
    try {
      const compiled = await compileD2Diagram(source);
      const result = await regenerateDiagram(compiled.ok ? compiled.diagram : null, compiled.ok ? null : compiled.error, {
        source,
        prior: { baseline, scene },
        baseScene: scene,
      });
      if (latest.current.source !== source || latest.current.scene !== scene) {
        setNotice("Newer edits arrived while regenerating, so they were kept. Regenerate again.");
        return;
      }
      setScene(result.scene);
      setBaseline(result.baseline);
      setDiagnostics(result.diagnostics);
      setConflicts(result.conflicts);
      setNotice(
        result.ok
          ? result.conflicts.length > 0
            ? `Regenerated, keeping your version in ${result.conflicts.length} ${result.conflicts.length === 1 ? "place" : "places"}.`
            : "Regenerated. Freehand additions and moved shapes were kept."
          : "The code does not compile, so the last valid canvas was kept.",
      );
    } finally {
      setRegenerating(false);
    }
  }, [scene, regenerating, pendingLabels.length, source, baseline]);

  const resetLayout = useCallback(async () => {
    if (frozen.current || !scene || regenerating) return;
    if (pendingLabels.length) {
      setNotice("Wait for the canvas label to reach the code before resetting.");
      return;
    }
    if (!window.confirm("Reset every moved or restyled shape to the generated layout? Freehand additions are kept.")) return;
    setNotice(null);
    setRegenerating(true);
    try {
      const compiled = await compileD2Diagram(source);
      if (!compiled.ok) {
        setNotice(`Not reset: the code does not compile (${compiled.error}).`);
        return;
      }
      const fresh = await regenerateDiagram(compiled.diagram, null, { source, prior: null, baseScene: null });
      if (latest.current.source !== source || latest.current.scene !== scene) {
        setNotice("Newer edits arrived while resetting, so they were kept. Reset again.");
        return;
      }
      const merged = resetOverrides({
        currentScene: toNativeScene(scene),
        freshScene: toNativeScene(fresh.scene),
        freshBaseline: fresh.baseline ?? { language: "d2", sourceHash: "", elements: {} },
      });
      setScene(toDrawingScene(merged.scene, scene));
      setBaseline(merged.baseline);
      setDiagnostics(merged.diagnostics);
      setConflicts([]);
      setNotice("Reset to the generated layout, with freehand additions kept. Save to keep it.");
    } catch (error) {
      setNotice(`Reset failed: ${message(error)}`);
    } finally {
      setRegenerating(false);
    }
  }, [scene, regenerating, pendingLabels.length, source]);

  /** Save the source and both generated files as one change. `overwrite` saves over files that changed meanwhile. */
  const save = useCallback(async (overwrite = false) => {
    if (frozen.current || saving) return;
    if (pendingLabels.length) {
      setNotice("Wait for the canvas label to reach the code before saving.");
      return;
    }
    // Ctrl+S can arrive before React has rendered the last keystrokes, so
    // save the latest code and canvas rather than this render's.
    const { source, scene } = latest.current;
    if (!scene) {
      setNotice("Nothing to save yet: the diagram has not compiled.");
      return;
    }
    const sidecar = diagramSidecarText(baseline, scene);
    const changed = source !== savedSource || !savedScene || !scenesEqual(savedScene, scene) || sidecar !== savedSidecarText;
    if (!changed && !overwrite && baseRevision !== null) {
      setNotice("No changes to save.");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const current = async (file: string, known: string | null) => (overwrite ? (await readDiagramCompanion(client, file))?.revision ?? null : known);
      const nativeText = saveDrawingFile(scene, null).text;
      const changes: LocalChange[] = [
        { kind: "write", path, content: source, expectedRevision: await current(path, baseRevision) },
        { kind: "write", path: nativePath, content: nativeText, expectedRevision: await current(nativePath, nativeRevision) },
        ...(sidecar === null ? [] : [{ kind: "write" as const, path: sidecarPath, content: sidecar, expectedRevision: await current(sidecarPath, sidecarRevision) }]),
      ];
      const results = await client.save(changes);
      for (const result of results) {
        if (result.path === path) {
          setBaseRevision(result.revision);
          setSavedSource(source);
        } else if (result.path === nativePath) {
          setNativeRevision(result.revision);
          setSavedScene(scene);
          setSavedNativeBytes(nativeText);
        } else if (result.path === sidecarPath) {
          setSidecarRevision(result.revision);
          setSavedSidecarText(sidecar);
          setSavedSidecarBytes(sidecar);
        }
      }
      setConflict(null);
      setChangedElsewhere(null);
      setNotice(`Saved ${path} and its generated files.`);
    } catch (error) {
      if (error instanceof LocalConflictError) setConflict({ path: error.path, revision: error.currentRevision, content: error.currentContent });
      else setNotice(`Not saved: ${message(error)} Your edits are kept.`);
    } finally {
      setSaving(false);
    }
  }, [saving, pendingLabels.length, baseline, savedSource, savedScene, savedSidecarText, baseRevision, client, path, nativePath, nativeRevision, sidecarPath, sidecarRevision]);

  // Ctrl or Cmd+S saves the active diagram (the code editor handles its own).
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

  /** Start over from the saved files (after a change from elsewhere, or loading the saved version). */
  const reopen = useCallback(async () => {
    const read = await client.read(path);
    if (read.revision === null || read.savedContent === null) return;
    setBooted(false);
    setConflict(null);
    setChangedElsewhere(null);
    setSource(read.savedContent);
    setSavedSource(read.savedContent);
    setBaseRevision(read.revision);
    // Unsaved edits are replaced, so their drafts go too.
    await Promise.all([path, nativePath, sidecarPath].map((file) => client.discardLocalDraft(file).catch(() => {})));
    setOpened({ source: read.savedContent, saved: read.savedContent, revision: read.revision });
  }, [client, path, nativePath, sidecarPath]);

  // A newer saved source (another tab, or sync): an untouched diagram reloads;
  // one with edits keeps them and offers the choice.
  const checking = useRef(false);
  useEffect(() => {
    if (!booted || savedRevision === undefined || savedRevision === null || savedRevision === baseRevision || saving) return;
    if (changedElsewhere === savedRevision || checking.current) return;
    checking.current = true;
    void (async () => {
      try {
        if (dirty) setChangedElsewhere(savedRevision);
        else await reopen();
      } finally {
        checking.current = false;
      }
    })();
  }, [booted, savedRevision, baseRevision, saving, changedElsewhere, dirty, reopen]);

  const baseName = path.split("/").pop()?.replace(/\.d2$/i, "") ?? "diagram";
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

  const fullBleed = desktop && active && view === "canvas" && booted && !bootError && scene !== null;
  const [stageRef, onStageScroll] = useCanvasStage(fullBleed);

  if (!booted) {
    return (
      <div className="wb-native-view">
        {navigation && (
          <div className="wb-compact-empty-toolbar">
            <CompactFileIdentity navigation={navigation} path={path} />
          </div>
        )}
        <p role="status" aria-live="polite" className="mt-2 px-3 text-sm text-neutral-500 dark:text-neutral-400">
          Compiling diagram…
        </p>
      </div>
    );
  }

  if (bootError || !scene) {
    return (
      <div className="wb-native-view">
        {navigation && (
          <div className="wb-compact-empty-toolbar">
            <CompactFileIdentity navigation={navigation} path={path} />
          </div>
        )}
        <div role="alert" className="mt-2 rounded-lg border border-red-300 bg-red-50 px-4 py-6 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">This diagram could not be opened, and nothing was changed.</p>
          <p className="mt-1 font-mono text-xs">{bootError ?? "No scene."}</p>
        </div>
      </div>
    );
  }

  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity !== "error");

  return (
    <div className="wb-native-view" data-canvas-bleed={fullBleed || undefined}>
      <TablineActions active={active}>
      <div className="wb-native-toolbar" data-compact-toolbar={navigation ? "" : undefined}>
        <CompactFileIdentity navigation={navigation} path={path} />
        <ViewSwitcher
          ariaLabel="Diagram view"
          options={[
            { value: "code" as const, label: "Code" },
            { value: "canvas" as const, label: "Canvas" },
          ]}
          active={view}
          onSelect={setView}
        />
        {!readOnly && dirty && (
          <button type="button" className="wb-button wb-button-primary wb-save" aria-keyshortcuts="Meta+S Control+S" title="Save (Cmd+S)" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        )}
        <ActionMenu>
          {!readOnly && (
            <button type="button" disabled={regenerating} onClick={() => void regenerate()} className={toolbarButton}>
              <WandSparkles className="size-4" aria-hidden /> {regenerating ? "Regenerating…" : "Regenerate"}
            </button>
          )}
          {!readOnly && (
            <button type="button" disabled={saving} onClick={() => void save()} className={toolbarButton}>
              <Save className="size-4" aria-hidden /> Save
            </button>
          )}
          {onDuplicate && (
            <button type="button" onClick={onDuplicate} className={toolbarButton}>
              <Copy className="size-4" aria-hidden /> Duplicate <MenuShortcut>{duplicateShortcutLabel()}</MenuShortcut>
            </button>
          )}
          {!readOnly && (
            <button type="button" onClick={() => void resetLayout()} className={toolbarButton}>
              <RotateCcw className="size-4" aria-hidden /> Reset layout
            </button>
          )}
          <button type="button" onClick={() => void exportSvg()} className={toolbarButton}>
            <Download className="size-4" aria-hidden /> SVG
          </button>
          <button type="button" onClick={() => void exportPng()} className={toolbarButton}>
            <Download className="size-4" aria-hidden /> PNG
          </button>
        </ActionMenu>
      </div>
      </TablineActions>

      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-neutral-200 py-1.5 font-mono text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
      >
        <span>{dirty ? "Unsaved changes" : "Saved"}</span>
        <span className="wb-native-detail">
          {scene.elements.length} elements · {conflicts.length} conflicts
        </span>
        {saving && <span>Saving…</span>}
        {notice && <span className="text-neutral-700 dark:text-neutral-200">{notice}</span>}
        {pendingLabels.length > 0 && <span role={labelError ? "alert" : "status"}>{labelError ?? "Updating the code with the canvas label…"}</span>}
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {errors.map((entry, index) => (
            <p key={index} className="font-mono text-xs">
              [{entry.code}] {entry.message}
            </p>
          ))}
          <p className="mt-1">The last valid canvas is kept, and saved files are untouched.</p>
        </div>
      )}
      {warnings.length > 0 && (
        <div className={banner}>
          {warnings.map((entry, index) => (
            <p key={index} className="font-mono text-xs">
              [{entry.code}] {entry.message}
            </p>
          ))}
        </div>
      )}
      {conflicts.length > 0 && (
        <div role="alert" className={banner}>
          <p className="font-medium">Where the code and your canvas changes disagree, your version was kept:</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {conflicts.map((entry, index) => (
              <li key={index}>
                {entry.elementId} ({entry.kind}): {entry.message}
              </li>
            ))}
          </ul>
          <p className="mt-1">Reset layout takes the generated version instead.</p>
        </div>
      )}

      {conflicted && onResolveConflict && (
        <ConflictBanner
          name={path}
          path={path}
          client={client}
          compareAs={{ kind: "text", language: "d2" }}
          noun="diagram"
          hasUnsavedEdits={() => dirty}
          onResolveConflict={onResolveConflict}
          onNotice={setNotice}
        />
      )}

      {(conflict || changedElsewhere) && (
        <div role="alert" className={banner}>
          <p>
            {conflict ? conflict.path : path} changed after you started editing this diagram, so nothing was saved. Your edits are still here.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (!dirty || window.confirm("Load the saved version and discard your unsaved edits?")) void reopen();
              }}
              className={bannerButton}
            >
              Load the saved version
            </button>
            <button type="button" onClick={() => void save(true)} className={bannerButton}>
              Save mine over it
            </button>
          </div>
        </div>
      )}

      <div hidden={view !== "code"} className="wb-native-stage">
        <SourceEditor
          initialText={opened.source}
          documentText={source}
          format="md"
          documentId={1}
          editorLanguage="d2"
          visible={active && view === "code"}
          renderError={errors[0]?.message ?? null}
          onChange={changeSource}
          onCursor={() => {}}
          onSave={() => (readOnly ? setNotice(readOnly) : void save())}
          apiRef={sourceApi}
          readOnly={readOnly}
        />
      </div>
      <div hidden={view !== "canvas"} className="wb-native-stage" data-canvas-stage="" ref={stageRef}>
        <DrawingCanvas
          scene={scene}
          onChange={changeCanvas}
          theme={theme}
          present={present}
          onScrollChange={onStageScroll}
          active={active && view === "canvas"}
          viewOnly={Boolean(readOnly)}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        Renaming a node on the canvas updates the code. Code changes reach the canvas on Regenerate, which keeps freehand additions and
        moved shapes. Generated files: <span className="font-mono">{nativePath}</span> and <span className="font-mono">{sidecarPath}</span>.
      </p>
    </div>
  );
}
