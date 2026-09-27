import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PhoneHeader, commandShortcut, isApplePlatform, type MenuEntry } from "@/features/design-system";
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
import { ConflictBanner } from "./ConflictBanner";
import { nativePathFor, projectDiagramArtifact, readDiagramCompanion } from "./diagramArtifact";
import { downloadBlob, downloadText } from "./download";
import type { OperationSession } from "./operationSession";
import { readProjectView, writeProjectView } from "./projectViews";
import type { TabFile } from "./tabs";
import { useCanvasPresentation, useCanvasTheme } from "./viewTheme";
import { FileHeader } from "./FileHeader";
import { useCanvasStage } from "./canvasStage";
import { canvasViewFrom, useCanvasViews, type CanvasView } from "./canvasViews";
import { useDesktopFrame } from "./tabline";
import type { WorkspaceStore } from "./workspaceStore";

const bannerButton =
  "inline-flex min-h-10 items-center rounded-lg px-3 font-medium wb-banner-button";
const banner =
  "mt-2 rounded-lg px-3 py-2 text-sm wb-banner-warn";

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
 * On a desktop, Split shows the code over the left half of the canvas, and
 * code changes reach the canvas as they are typed (the canvas is view-only
 * while the code does not compile).
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
  const present = useCanvasPresentation("diagram");
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
  const [mode, setMode] = useState<CanvasView>(() => canvasViewFrom(readProjectView(client.persistenceKey, path)));
  useEffect(() => {
    writeProjectView(client.persistenceKey, path, mode);
  }, [client.persistenceKey, path, mode]);
  const { view, header: viewHeader } = useCanvasViews(mode, active, setMode, "Diagram view");
  /** The code the canvas was last generated from. */
  const generatedFrom = useRef<string | null>(null);
  // Set at open when the canvas had to be generated (none saved, or the code changed since).
  const generatedAtOpen = useRef(false);
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
        generatedFrom.current = result.source;
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
        generatedFrom.current = opened.source;
        generatedAtOpen.current = result.ok && result.scene !== result.persistedScene && !result.conflicts.length;
        if (!result.ok) setMode("source");
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
      generatedFrom.current = source;
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
      generatedFrom.current = source;
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

  // Split: code changes reach the canvas as they are typed, as Regenerate
  // does, without its notices.
  useEffect(() => {
    if (view !== "split" || !booted || !scene || regenerating || pendingLabels.length || source === generatedFrom.current) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (frozen.current) return;
        const compiled = await compileD2Diagram(source);
        const result = await regenerateDiagram(compiled.ok ? compiled.diagram : null, compiled.ok ? null : compiled.error, {
          source,
          prior: { baseline, scene },
          baseScene: scene,
        });
        if (!alive || latest.current.source !== source || latest.current.scene !== scene) return;
        generatedFrom.current = source;
        setScene(result.scene);
        setBaseline(result.baseline);
        setDiagnostics(result.diagnostics);
        setConflicts(result.conflicts);
      })();
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [view, booted, scene, regenerating, pendingLabels.length, source, baseline]);

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

  // A canvas generated at open follows from the saved code, so it is saved
  // straight away rather than shown as unsaved edits nobody made (a diagram an
  // agent wrote, for example). If that save fails, the diagram shows as unsaved.
  useEffect(() => {
    if (!generatedAtOpen.current || !booted || locked || saving || !scene) return;
    if (source !== savedSource || baseRevision === null || pendingLabels.length) {
      generatedAtOpen.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      generatedAtOpen.current = false;
      void save();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [booted, locked, saving, scene, source, savedSource, baseRevision, pendingLabels.length, save]);

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

  const fullBleed = desktop && active && view !== "source" && booted && !bootError && scene !== null;
  const [stageRef, onStageScroll] = useCanvasStage(fullBleed);

  if (!booted) {
    return (
      <div className="wb-native-view">
        {navigation && <PhoneHeader back={navigation} className="relative" />}
        <p role="status" aria-live="polite" className="mt-2 px-3 text-[13px] text-muted-foreground">
          Compiling diagram…
        </p>
      </div>
    );
  }

  if (bootError || !scene) {
    return (
      <div className="wb-native-view">
        {navigation && <PhoneHeader back={navigation} className="relative" />}
        <div role="alert" className="mt-2 rounded-lg px-4 py-6 text-sm wb-banner-danger">
          <p className="font-medium">This diagram could not be opened, and nothing was changed.</p>
          <p className="mt-1 font-mono text-xs">{bootError ?? "No scene."}</p>
        </div>
      </div>
    );
  }

  const duplicateKey = commandShortcut("D", isApplePlatform());
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity !== "error");
  // In Split the canvas is view-only while the code does not compile.
  const canvasViewOnly = Boolean(readOnly) || (view === "split" && errors.length > 0);

  return (
    <div className="wb-native-view" data-canvas-bleed={fullBleed || undefined} data-view={view}>
      <FileHeader
        path={path}
        active={active}
        navigation={navigation}
        view={viewHeader}
        save={!readOnly && dirty ? { disabled: saving, onSave: () => void save() } : null}
        actions={[
          ...(readOnly ? [] : [{ label: regenerating ? "Regenerating…" : "Regenerate", disabled: regenerating, onSelect: () => void regenerate() }]),
          ...(readOnly ? [] : [{ label: "Save", disabled: saving, onSelect: () => void save() }]),
          ...(onDuplicate ? [{ label: "Duplicate", shortcut: duplicateKey.label, keyShortcuts: duplicateKey.aria, onSelect: onDuplicate }] : []),
          ...(readOnly ? [] : [{ label: "Reset layout", onSelect: () => void resetLayout() }]),
          { label: "SVG", onSelect: () => void exportSvg() },
          { label: "PNG", onSelect: () => void exportPng() },
        ] satisfies MenuEntry[]}
      />

      {/* The saved state, the diagram's counts and the last notice, for
          screen readers: Save and the tab's unsaved dot show it on screen. */}
      <div aria-live="polite" className="sr-only">
        <span>{dirty ? "Unsaved changes" : "Saved"}</span>
        <span>
          {scene.elements.length} elements · {conflicts.length} conflicts
        </span>
        {saving && <span>Saving…</span>}
        {notice && <span>{notice}</span>}
        {pendingLabels.length > 0 && <span role={labelError ? "alert" : "status"}>{labelError ?? "Updating the code with the canvas label…"}</span>}
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-lg px-3 py-2 text-sm wb-banner-danger"
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

      <div hidden={view === "canvas"} className="wb-native-stage wb-native-source">
        <SourceEditor
          initialText={opened.source}
          documentText={source}
          format="md"
          documentId={1}
          editorLanguage="d2"
          visible={active && view !== "canvas"}
          renderError={errors[0]?.message ?? null}
          onChange={changeSource}
          onCursor={() => {}}
          onSave={() => (readOnly ? setNotice(readOnly) : void save())}
          apiRef={sourceApi}
          readOnly={readOnly}
        />
      </div>
      <div hidden={view === "source"} className="wb-native-stage" data-canvas-stage="" ref={stageRef}>
        <DrawingCanvas
          scene={scene}
          onChange={changeCanvas}
          theme={theme}
          present={present}
          onScrollChange={onStageScroll}
          compact={!desktop}
          active={active && view !== "source"}
          viewOnly={canvasViewOnly}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Renaming a node on the canvas updates the code. Code changes reach the canvas on Regenerate, which keeps freehand additions and
        moved shapes. Generated files: <span className="font-mono">{nativePath}</span> and <span className="font-mono">{sidecarPath}</span>.
      </p>
    </div>
  );
}
