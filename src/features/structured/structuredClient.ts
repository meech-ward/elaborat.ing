import { emitNativeScene } from "@/features/structured/emitter.ts";
import {
  isGeneratedId,
  mergeRegeneration,
  recordForElement,
  resetOverrides,
} from "@/features/structured/merge.ts";
import { parseOverrideSidecar, serializeOverrideSidecar } from "@/features/structured/sidecar.ts";
import type {
  D2Diagram,
  Diagnostic,
  ExcalidrawElementSkeleton,
  GeneratedBaseline,
  MergeConflict,
  NativeScene,
  OverrideSidecar,
} from "@/features/structured/types.ts";
import type { DrawingElement, DrawingScene } from "@/features/drawings/index.ts";
import { hashSource as hashDiagramSource } from "@/features/structured/sourceHash.ts";
export { hashSource as hashDiagramSource } from "@/features/structured/sourceHash.ts";

/**
 * Browser-side structured-diagram orchestration.
 *
 * The caller supplies the compiled D2 diagram (or its error); this module
 * emits and merges locally with the structured feature's pure modules and
 * adapts scenes to the drawings envelope the native canvas owns. Roadmap
 * phase 2 step 14 wires it to the in-browser compiler in `./compiler.ts`.
 */

/** Native merge scene -> drawings envelope the canvas owns. */
export function toDrawingScene(native: NativeScene, base?: DrawingScene | null): DrawingScene {
  return {
    type: "excalidraw",
    version: base?.version ?? 2,
    elements: native.elements.map((el) => ({ ...el })),
    ...(base?.appState !== undefined ? { appState: { ...base.appState } } : {}),
    ...(base?.files !== undefined ? { files: { ...base.files } } : {}),
    ...(base?.source !== undefined ? { source: base.source } : {}),
    ...(base?.extra !== undefined ? { extra: { ...base.extra } } : {}),
  };
}

/** Drawings envelope -> native merge scene (appState/files ride on `base`). */
export function toNativeScene(scene: DrawingScene): NativeScene {
  return {
    elements: scene.elements.map((el) => ({
      ...el,
      width: typeof el.width === "number" ? el.width : 0,
      height: typeof el.height === "number" ? el.height : 0,
    })),
  };
}

function baselineForScene(source: string, scene: NativeScene): GeneratedBaseline {
  const elements: GeneratedBaseline["elements"] = {};
  for (const el of scene.elements) {
    if (el.id.startsWith("d2:")) elements[el.id] = recordForElement(el);
  }
  return { language: "d2", sourceHash: hashDiagramSource(source), elements };
}

export interface RegenerateInput {
  source: string;
  prior: { baseline: GeneratedBaseline | null; scene: DrawingScene } | null;
  baseScene: DrawingScene | null;
}

export interface RegenerateResult {
  /** False when D2 reported a syntax error: scene/baseline are the preserved prior. */
  ok: boolean;
  scene: DrawingScene;
  baseline: GeneratedBaseline | null;
  diagnostics: Diagnostic[];
  conflicts: MergeConflict[];
}

/**
 * Regenerate a diagram: fresh D2 geometry merged against the current canvas
 * scene. A failing compile preserves the prior scene (the last valid scene
 * stays on canvas) and reports a diagnostic; nothing is deleted.
 */
export async function regenerateDiagram(
  diagram: D2Diagram | null,
  diagramError: string | null,
  input: RegenerateInput,
): Promise<RegenerateResult> {
  if (diagramError || !diagram) {
    return {
      ok: false,
      scene: input.prior?.scene ?? toDrawingScene({ elements: [] }, input.baseScene),
      baseline: input.prior?.baseline ?? null,
      diagnostics: [
        {
          severity: "error",
          code: "d2/syntax",
          message: diagramError ?? "diagram compile failed with no detail",
        },
      ],
      conflicts: [],
    };
  }
  const emitted = emitNativeScene(diagram);
  const freshScene: NativeScene = { elements: emitted.elements };
  const freshBaseline = baselineForScene(input.source, freshScene);
  if (!input.prior) {
    return {
      ok: true,
      scene: toDrawingScene(freshScene, input.baseScene),
      baseline: freshBaseline,
      diagnostics: emitted.diagnostics,
      conflicts: [],
    };
  }
  const merged = mergeRegeneration({
    baseline: input.prior.baseline,
    currentScene: toNativeScene(input.prior.scene),
    freshScene,
    freshBaseline,
  });
  return {
    ok: true,
    scene: toDrawingScene(merged.scene, input.baseScene ?? input.prior.scene),
    baseline: merged.baseline,
    diagnostics: [...emitted.diagnostics, ...merged.diagnostics],
    conflicts: merged.conflicts,
  };
}

export { resetOverrides };

/** Sidecar path next to the `.d2` source (ordinary JSON, workspace-allowed). */
export function sidecarPathFor(sourcePath: string): string {
  return `${sourcePath}.json`;
}

/** A drawings envelope element as the merge's native skeleton (defaults for missing geometry). */
function skeletonForElement(el: DrawingElement): ExcalidrawElementSkeleton {
  return {
    ...el,
    width: typeof el.width === "number" ? el.width : 0,
    height: typeof el.height === "number" ? el.height : 0,
  };
}

/**
 * Collect user overrides (generated ids whose geometry/style differs from
 * the baseline) for the sidecar. Freehand elements and deletions are merge
 * state, not overrides, and are never written here. The baseline itself is
 * stored alongside: reopen merges old baseline + saved native + new
 * compile, so an external source edit reads as a generator change rather
 * than a fake human override.
 */
export function collectOverrides(
  baseline: GeneratedBaseline | null,
  scene: DrawingScene,
): OverrideSidecar | null {
  if (!baseline) return null;
  const overrides: OverrideSidecar["overrides"] = {};
  const byId = new Map(scene.elements.map((el) => [el.id, el]));
  for (const [id, base] of Object.entries(baseline.elements)) {
    const current = byId.get(id);
    if (!current) continue;
    const now = recordForElement(skeletonForElement(current));
    const changed: Record<string, unknown> = {};
    for (const field of ["x", "y", "width", "height"] as const) {
      if (!valuesEqual(base[field], now[field])) changed[field] = now[field];
    }
    const styleChanged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(now.style)) {
      if (!valuesEqual((base.style as Record<string, unknown>)[key], value)) {
        styleChanged[key] = value;
      }
    }
    if (Object.keys(styleChanged).length > 0) changed.style = styleChanged;
    if (Object.keys(changed).length > 0) overrides[id] = changed;
  }
  if (Object.keys(overrides).length === 0) return null;
  return { version: 1, language: "d2", sourceHash: baseline.sourceHash, overrides, baseline };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Parse a sidecar file; null when absent, throws a descriptive error when corrupt. */
export function readSidecarFile(content: string | null): OverrideSidecar | null {
  if (content === null) return null;
  return parseOverrideSidecar(content);
}

/** Serialize collected overrides (or null when there is nothing to store). */
export function writeSidecarFile(sidecar: OverrideSidecar | null): string | null {
  if (!sidecar) return null;
  return serializeOverrideSidecar(sidecar);
}

/**
 * Re-apply sidecar overrides onto a freshly compiled scene (e.g. after
 * reopening the file). Unknown ids are skipped with a warning; a stale
 * sourceHash applies anyway with a warning diagnostic, since explicit user
 * moves outlive source edits until reset.
 */
export function applySidecar(
  scene: DrawingScene,
  sidecar: OverrideSidecar | null,
  baseline: GeneratedBaseline | null,
): { scene: DrawingScene; diagnostics: Diagnostic[] } {
  if (!sidecar) return { scene, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  if (baseline && sidecar.sourceHash !== baseline.sourceHash) {
    diagnostics.push({
      severity: "warning",
      code: "sidecar/stale",
      message: "Override sidecar was saved for an older source; moves still applied, reset to drop them.",
    });
  }
  const ids = new Set(scene.elements.map((el) => el.id));
  let skipped = 0;
  for (const id of Object.keys(sidecar.overrides)) {
    if (!ids.has(id)) skipped += 1;
  }
  const elements = scene.elements.map((el) => {
    const override = sidecar.overrides[el.id];
    if (!override) return el;
    if (!isGeneratedId(el.id)) return el;
    const next: DrawingScene["elements"][number] = { ...el };
    for (const [field, value] of Object.entries(override)) {
      // Collected `style` groups map back onto the flat native style keys.
      if (field === "style" && typeof value === "object" && value !== null) {
        for (const [styleKey, styleValue] of Object.entries(value)) {
          Object.assign(next, { [styleKey]: styleValue });
        }
      } else {
        Object.assign(next, { [field]: value });
      }
    }
    return next;
  });
  if (skipped > 0) {
    diagnostics.push({
      severity: "warning",
      code: "sidecar/skipped",
      message: `${skipped} override(s) target ids absent from the fresh compile; ignored until those ids return.`,
    });
  }
  return { scene: { ...scene, elements }, diagnostics };
}
