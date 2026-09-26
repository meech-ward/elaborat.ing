import { describe, expect, test } from "bun:test";
import { mergeRegeneration, recordForElement } from "@/features/structured/merge.ts";
import { parseOverrideSidecar } from "@/features/structured/sidecar.ts";
import type { DrawingScene } from "@/features/drawings/index.ts";
import type { GeneratedBaseline } from "@/features/structured/types.ts";
import {
  applySidecar,
  collectOverrides,
  hashDiagramSource,
  readSidecarFile,
  regenerateDiagram,
  sidecarPathFor,
  toDrawingScene,
  toNativeScene,
  writeSidecarFile,
} from "./structuredClient.ts";

function sceneWith(elements: Array<Record<string, unknown>>): DrawingScene {
  return {
    type: "excalidraw",
    version: 2,
    elements: elements.map((el) => ({ id: "x", type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...el })),
  };
}

function baselineFor(elements: Array<Record<string, unknown>>): GeneratedBaseline {
  const records: GeneratedBaseline["elements"] = {};
  for (const el of elements) {
    const id = String(el.id);
    records[id] = recordForElement({
      id,
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ...el,
    });
  }
  return { language: "d2", sourceHash: hashDiagramSource("a -> b"), elements: records };
}

describe("structuredClient scene adapters", () => {
  test("native round trip keeps appState, files and unknown envelope fields", () => {
    const scene: DrawingScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ id: "a", type: "rectangle", x: 1, y: 2, width: 30, height: 40 }],
      appState: { theme: "dark" },
      files: { f1: { mimeType: "image/png", id: "f1", dataURL: "data:,x", created: 1 } },
      extra: { future: true },
    };
    const back = toDrawingScene(toNativeScene(scene), scene);
    expect(back.appState).toEqual({ theme: "dark" });
    expect(back.files).toEqual(scene.files);
    expect(back.extra).toEqual({ future: true });
    expect(back.elements).toEqual(scene.elements);
  });

  test("sidecar path sits next to the source", () => {
    expect(sidecarPathFor("diagrams/flow.d2")).toBe("diagrams/flow.d2.json");
  });
});

describe("structuredClient regenerate failure", () => {
  test("a failed compile preserves the prior scene and baseline", async () => {
    const priorScene = sceneWith([{ id: "d2:a", width: 10, height: 10 }]);
    const baseline = baselineFor([{ id: "d2:a" }]);
    const result = await regenerateDiagram(null, "D2 syntax error: boom", {
      source: "broken :::",
      prior: { baseline, scene: priorScene },
      baseScene: null,
    });
    expect(result.ok).toBe(false);
    expect(result.scene).toBe(priorScene);
    expect(result.baseline).toBe(baseline);
    expect(result.diagnostics.some((d) => d.code === "d2/syntax")).toBe(true);
  });
});

describe("structuredClient overrides", () => {
  test("collect then apply round trips a user move", () => {
    const baseline = baselineFor([{ id: "d2:a", x: 0, y: 0 }]);
    const moved = sceneWith([{ id: "d2:a", x: 40, y: 0, width: 10, height: 10 }]);
    const sidecar = collectOverrides(baseline, moved);
    expect(sidecar).not.toBeNull();
    expect(sidecar?.overrides["d2:a"]).toMatchObject({ x: 40 });
    // Fresh compile at the old position plus the sidecar restores the move.
    const fresh = sceneWith([{ id: "d2:a", x: 0, y: 0, width: 10, height: 10 }]);
    const applied = applySidecar(fresh, sidecar, baseline);
    expect(applied.scene.elements[0]).toMatchObject({ x: 40, y: 0 });
    expect(applied.diagnostics).toEqual([]);
  });

  test("save with a user move, close, external label change, reopen keeps both", () => {
    // v1 generation: node at x=0 labelled A.
    const v1baseline = baselineFor([{ id: "d2:a", x: 0, y: 0, width: 10, height: 10, text: "A" }]);
    // User drags the node, then saves: sidecar stores the move AND the
    // v1 baseline it was collected against.
    const moved = sceneWith([{ id: "d2:a", x: 40, y: 0, width: 10, height: 10, text: "A" }]);
    const sidecar = collectOverrides(v1baseline, moved);
    expect(sidecar).not.toBeNull();
    expect(sidecar?.baseline).toEqual(v1baseline);
    const sidecarText = writeSidecarFile(sidecar);
    expect(sidecarText).not.toBeNull();
    // Close, then an agent edits the D2 label while the app is closed.
    const v2 = sceneWith([{ id: "d2:a", x: 0, y: 0, width: 10, height: 10, text: "B" }]);
    const v2baseline = baselineFor([{ id: "d2:a", x: 0, y: 0, width: 10, height: 10, text: "B" }]);
    // Reopen like the diagram view does: old baseline + saved native +
    // new compile. Both the user move and the new label must survive.
    const stored = readSidecarFile(sidecarText);
    expect(stored?.baseline).toEqual(v1baseline);
    expect(() => parseOverrideSidecar(sidecarText as string)).not.toThrow();
    const merged = mergeRegeneration({
      baseline: stored?.baseline ?? v2baseline,
      currentScene: toNativeScene(moved),
      freshScene: toNativeScene(v2),
      freshBaseline: v2baseline,
    });
    expect(merged.conflicts).toEqual([]);
    const node = merged.scene.elements.find((el) => el.id === "d2:a");
    expect(node?.x).toBe(40);
    expect(node?.text).toBe("B");
  });

  test("no user changes collect to null; stale sidecars warn, unknown ids skip", () => {
    const baseline = baselineFor([{ id: "d2:a" }]);
    const same = sceneWith([{ id: "d2:a", x: 0, y: 0, width: 10, height: 10 }]);
    expect(collectOverrides(baseline, same)).toBeNull();
    expect(collectOverrides(null, same)).toBeNull();
    const stale = {
      version: 1 as const,
      language: "d2" as const,
      sourceHash: "deadbeef",
      overrides: { "d2:a": { x: 5 }, "d2:gone": { x: 1 } },
      baseline: null,
    };
    const applied = applySidecar(same, stale, baseline);
    expect(applied.scene.elements[0]).toMatchObject({ x: 5 });
    expect(applied.diagnostics.map((d) => d.code).sort()).toEqual(["sidecar/skipped", "sidecar/stale"]);
  });
});
